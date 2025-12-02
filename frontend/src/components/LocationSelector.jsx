/**
 * LocationSelector - Reusable component for selecting/managing user locations
 * Used in header user menu and MultiView settings modal
 */
import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

const LocationSelector = ({
  onLocationChange,
  compact = false,  // Compact mode for header dropdown
  showLabel = true,
  className = ''
}) => {
  const [locations, setLocations] = useState([]);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCity, setNewCity] = useState('');
  const [newState, setNewState] = useState('');
  const [error, setError] = useState(null);
  const [autoDetectAttempted, setAutoDetectAttempted] = useState(false);
  const buttonRef = useRef(null);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      // Check if click is outside both the button and the dropdown
      if (
        buttonRef.current && !buttonRef.current.contains(e.target) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
        setShowAddForm(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load locations on mount
  useEffect(() => {
    loadLocations();
  }, []);

  // Auto-detect location if none exists (only once)
  useEffect(() => {
    if (!loading && !autoDetectAttempted && locations.length === 0 && !detecting) {
      setAutoDetectAttempted(true);
      handleDetectLocation();
    }
  }, [loading, locations, autoDetectAttempted, detecting]);

  const getAuthToken = () => {
    return localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
  };

  const loadLocations = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) {
        setLoading(false);
        return;
      }

      const response = await fetch('/api/user/locations', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setLocations(data.locations || []);
        const current = data.locations?.find(l => l.isCurrent);
        setCurrentLocation(current || null);
        if (current && onLocationChange) {
          onLocationChange(current);
        }
      }
    } catch (err) {
      console.error('Failed to load locations:', err);
      setError('Failed to load locations');
    } finally {
      setLoading(false);
    }
  };

  const handleDetectLocation = async () => {
    try {
      setDetecting(true);
      setError(null);
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch('/api/user/locations/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();
      if (data.success) {
        await loadLocations();
        setShowDropdown(false);
      } else {
        setError(data.error || 'Could not detect location');
      }
    } catch (err) {
      console.error('Failed to detect location:', err);
      setError('Failed to detect location');
    } finally {
      setDetecting(false);
    }
  };

  const handleSelectLocation = async (locationId) => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch(`/api/user/locations/${locationId}/select`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();
      if (data.success) {
        await loadLocations();
        setShowDropdown(false);
      }
    } catch (err) {
      console.error('Failed to select location:', err);
    }
  };

  const handleAddLocation = async (e) => {
    e.preventDefault();
    if (!newCity.trim() || !newState.trim()) return;

    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch('/api/user/locations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          city: newCity.trim(),
          state: newState.trim(),
          setAsCurrent: true
        })
      });

      const data = await response.json();
      if (data.success) {
        setNewCity('');
        setNewState('');
        setShowAddForm(false);
        await loadLocations();
        setShowDropdown(false);
      } else {
        setError(data.error || 'Failed to add location');
      }
    } catch (err) {
      console.error('Failed to add location:', err);
      setError('Failed to add location');
    }
  };

  const handleDeleteLocation = async (locationId, e) => {
    e.stopPropagation();
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch(`/api/user/locations/${locationId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        await loadLocations();
      }
    } catch (err) {
      console.error('Failed to delete location:', err);
    }
  };

  const formatLocation = (location) => {
    if (!location) return 'No location set';
    return `${location.city}, ${location.stateAbbrev || location.state}`;
  };

  if (loading) {
    return (
      <div className={`flex items-center gap-2 text-slate-400 ${className}`}>
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  // Calculate dropdown position
  const getDropdownPosition = () => {
    if (!buttonRef.current) return { top: 0, left: 0 };
    const rect = buttonRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 8,
      left: Math.max(8, rect.right - 288) // 288px = w-72, ensure it doesn't go off left edge
    };
  };

  return (
    <div className={`relative ${className}`}>
      {/* Current Location Button */}
      <button
        ref={buttonRef}
        onClick={() => setShowDropdown(!showDropdown)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg transition ${
          compact
            ? 'text-sm text-slate-300 hover:text-white hover:bg-slate-700/50'
            : 'bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700'
        }`}
      >
        <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {showLabel && (
          <span className={compact ? '' : 'font-medium'}>
            {detecting ? 'Detecting...' : (currentLocation ? formatLocation(currentLocation) : 'Set Location')}
          </span>
        )}
        {detecting ? (
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          <svg className={`w-4 h-4 transition-transform ${showDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Dropdown Menu - Rendered via Portal */}
      {showDropdown && buttonRef.current && ReactDOM.createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-72 bg-slate-800 rounded-xl border border-slate-700 shadow-2xl overflow-hidden"
          style={{
            top: getDropdownPosition().top,
            left: getDropdownPosition().left,
            zIndex: 99999
          }}
        >
          {/* Saved Locations */}
          {locations.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Saved Locations
              </div>
              {locations.map((location) => (
                <button
                  key={location.id}
                  onClick={() => handleSelectLocation(location.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 hover:bg-slate-700/50 transition ${
                    location.isCurrent ? 'bg-slate-700/30' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {location.isCurrent && (
                      <svg className="w-4 h-4 text-cyan-400" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                    {!location.isCurrent && <div className="w-4" />}
                    <span className="text-slate-200">{formatLocation(location)}</span>
                    {location.isAutoDetected && (
                      <span className="text-xs text-slate-500">(detected)</span>
                    )}
                  </div>
                  <button
                    onClick={(e) => handleDeleteLocation(location.id, e)}
                    className="p-1 text-slate-500 hover:text-red-400 transition"
                    title="Delete location"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </button>
              ))}
            </div>
          )}

          {/* Divider */}
          {locations.length > 0 && <div className="border-t border-slate-700" />}

          {/* Actions */}
          <div className="py-2">
            {/* Add New Location */}
            {showAddForm ? (
              <form onSubmit={handleAddLocation} className="px-3 py-2 space-y-2">
                <input
                  type="text"
                  placeholder="City"
                  value={newCity}
                  onChange={(e) => setNewCity(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="State (e.g., California or CA)"
                  value={newState}
                  onChange={(e) => setNewState(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setNewCity('');
                      setNewState('');
                    }}
                    className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-slate-700/50 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span>Add new location</span>
              </button>
            )}

            {/* Detect Location */}
            <button
              onClick={handleDetectLocation}
              disabled={detecting}
              className="w-full flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-slate-700/50 transition disabled:opacity-50"
            >
              {detecting ? (
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )}
              <span>{detecting ? 'Detecting...' : 'Detect my location'}</span>
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="px-3 py-2 bg-red-500/10 border-t border-red-500/20">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default LocationSelector;
