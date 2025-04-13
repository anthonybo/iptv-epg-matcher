import React, { useState, useEffect } from 'react';
import { getCurrentSession } from '../services/ApiService';

const MainLayout = () => {
  const [sessionId, setSessionId] = useState(null);
  
  // Initialize session ID from stored value on component mount
  useEffect(() => {
    const storedSessionId = getCurrentSession();
    if (storedSessionId) {
      console.log(`Restored session ID from storage: ${storedSessionId}`);
      setSessionId(storedSessionId);
    }
  }, []);

  return (
    <div>
      {/* existing rendering code */}
    </div>
  );
}

export default MainLayout;