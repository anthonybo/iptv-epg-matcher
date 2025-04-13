import React from 'react';
import { Card } from 'react-bootstrap';

const ChannelCard = ({ channel }) => {
  console.log('ChannelCard render:', { 
    id: channel.id || channel.uuid, 
    name: channel.name, 
    groupTitle: channel.groupTitle 
  });

  // Function to create a placeholder image with the first letter of the channel name
  const createPlaceholderImage = (name) => {
    const firstLetter = (name && name.length > 0) ? name[0].toUpperCase() : '?';
    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
    const colorIndex = Math.abs(name.charCodeAt(0) % colors.length);
    
    return (
      <div 
        style={{
          width: '100%',
          height: '60px',
          backgroundColor: colors[colorIndex],
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '24px',
          fontWeight: 'bold',
          borderRadius: '4px 4px 0 0'
        }}
      >
        {firstLetter}
      </div>
    );
  };

  return (
    <Card className="h-100 shadow-sm">
      {channel.tvgLogo ? (
        <Card.Img 
          variant="top" 
          src={channel.tvgLogo} 
          alt={channel.name} 
          style={{ height: '60px', objectFit: 'contain', padding: '5px', backgroundColor: '#f8f9fa' }}
          onError={(e) => {
            console.log('Image failed to load:', channel.tvgLogo);
            e.target.style.display = 'none';
            e.target.parentNode.insertBefore(
              createPlaceholderImage(channel.name).props.children, 
              e.target
            );
          }}
        />
      ) : (
        createPlaceholderImage(channel.name)
      )}
      
      <Card.Body>
        <Card.Title style={{ 
          fontSize: '0.9rem', 
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {channel.name || 'Unnamed Channel'}
        </Card.Title>
        
        <Card.Text style={{ 
          fontSize: '0.8rem', 
          color: '#6c757d',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {channel.groupTitle || 'No Category'}
        </Card.Text>
      </Card.Body>
    </Card>
  );
};

export default ChannelCard; 