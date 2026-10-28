// The backend's token response (POST /api/network-test/token). The token
// itself is handed to the SDK and never kept; the rest describes the run.
export interface TokenData {
  token: string;
  expires_at: string;
  expires_in: number;
  region: string;
  // The Fabric address of the echo script the voice steps dial, bare (the
  // runner appends ?channel=audio). null when the region has none.
  echo_address: string | null;
  // The Fabric address of a video room for the two video steps; null skips
  // them.
  video_room_address: string | null;
}

// GET /api/network-test/config: what the page needs before it can start.
export interface NetworkTestConfig {
  regions: string[];
  default_region: string;
  captcha_required: boolean;
}
