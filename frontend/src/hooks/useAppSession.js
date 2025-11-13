import { useEffect } from 'react';
import { useAppContext } from '../contexts/AppContext';
import SessionManager from '../utils/sessionManager';

export function useAppSession() {
  const { sessionId, setSessionId, initialized, setInitialized } = useAppContext();

  // Initialize session on mount
  useEffect(() => {
    SessionManager.setupSessionListener();

    const initSession = async () => {
      try {
        const existingSessionId = SessionManager.getSessionId();

        if (existingSessionId) {
          console.log(`Found saved session, validating: ${existingSessionId}`);

          const isValid = await SessionManager.validateSession(existingSessionId);

          if (isValid) {
            console.log(`Session ${existingSessionId} is valid, using it`);
            setSessionId(existingSessionId);
          } else {
            console.log(`Session ${existingSessionId} is invalid, creating new one`);
            const newSessionId = await SessionManager.init();
            if (newSessionId) {
              setSessionId(newSessionId);
            } else {
              console.error('Failed to create a new session');
            }
          }
        } else {
          console.log('No existing session found, creating a new one');
          const newSessionId = await SessionManager.init();
          if (newSessionId) {
            setSessionId(newSessionId);
          } else {
            console.error('Failed to create a new session');
          }
        }

        setInitialized(true);
      } catch (error) {
        console.error('Error during session initialization:', error);
        setInitialized(true);
      }
    };

    if (!initialized) {
      initSession();
    }
  }, [initialized, setSessionId, setInitialized]);

  const clearSession = () => {
    SessionManager.clearSession();
    setSessionId(null);
  };

  const saveSessionId = (sid) => {
    SessionManager.saveSessionId(sid);
    setSessionId(sid);
  };

  return {
    sessionId,
    initialized,
    clearSession,
    saveSessionId,
  };
}
