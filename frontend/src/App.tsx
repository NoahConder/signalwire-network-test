import { useEffect } from 'react';
import NetworkTest from './components/NetworkTest';
import { signalWireService } from './services/signalwire';

function App() {
  useEffect(() => {
    // A tab closed mid-run: end the session so the running call doesn't sit
    // on the server until it times out.
    const handleBeforeUnload = () => {
      void signalWireService.disconnect();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  return <NetworkTest />;
}

export default App;
