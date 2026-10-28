import os
import logging
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

# backend/.env is the only env file (vite.config.ts reads it too).
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# CORS for the dev server or a separately hosted frontend. No cookies are
# involved (the API key travels in a header), so credentials support isn't
# needed.
frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:5173')
CORS(app, origins=[frontend_url])

from api.network_test import captcha_mode, network_test_bp
from utils.signalwire import load_regions

app.register_blueprint(network_test_bp, url_prefix='/api/network-test')

# Request headers whose values must never reach the log.
_SENSITIVE_HEADERS = {'x-api-key', 'authorization', 'cookie'}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.route('/')
def index():
    """Liveness."""
    return jsonify({
        "status": "online",
        "service": "SignalWire Network Test Backend",
        "timestamp": _now_iso(),
        "version": "0.1.0"
    })


@app.route('/health')
def health_check():
    """Configuration health: which regions are served, whether the API key is
    set (without it every /api route fails closed) and how the captcha is
    configured ('turnstile', 'disabled' for local development, or
    'unconfigured', which refuses to mint)."""
    try:
        regions = sorted(load_regions())
        api_key_configured = bool(os.getenv('NETWORK_TEST_API_KEY'))
        captcha = captcha_mode()
        healthy = bool(regions) and api_key_configured and captcha != 'unconfigured'
        return jsonify({
            "status": "healthy" if healthy else "degraded",
            "checks": {
                "server": True,
                "regions": regions,
                "api_key": api_key_configured,
                "captcha": captcha,
                "timestamp": _now_iso()
            }
        }), 200 if healthy else 503
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return jsonify({
            "status": "unhealthy",
            "error": "Health check failed"
        }), 503


@app.errorhandler(404)
def not_found(error):
    return jsonify({
        "error": "Endpoint not found",
        "status": 404
    }), 404


@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {str(error)}")
    return jsonify({
        "error": "Internal server error",
        "status": 500
    }), 500


@app.before_request
def log_request_info():
    """Log incoming requests at DEBUG, with secrets redacted. Bodies aren't
    logged: the token endpoint posts captcha tokens."""
    if logger.isEnabledFor(logging.DEBUG):
        headers = {
            name: ('<redacted>' if name.lower() in _SENSITIVE_HEADERS else value)
            for name, value in request.headers.items()
        }
        logger.debug(f"{request.method} {request.path} headers={headers} body_bytes={request.content_length or 0}")


if __name__ == '__main__':
    if not load_regions():
        logger.warning("No region configured: set NETWORK_TEST_REGIONS, or SPACE_NAME/PROJECT_ID/AUTH_TOKEN "
                       "for a single space (see .env.example)")
    if captcha_mode() == 'unconfigured':
        logger.warning("Captcha not configured: /api/network-test/token will refuse. Set TURNSTILE_SECRET, "
                       "or NETWORK_TEST_ALLOW_NO_CAPTCHA=true for local development")

    port = int(os.getenv('PORT', 5001))
    # FLASK_DEBUG=True turns on the Werkzeug debugger (code execution from the
    # browser) while the server listens on 0.0.0.0 -- leave it off.
    debug = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'

    logger.info(f"Starting SignalWire Network Test Backend on port {port}")
    app.run(host='0.0.0.0', port=port, debug=debug)
