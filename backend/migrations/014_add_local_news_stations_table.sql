-- Migration: 014
-- Description: Add local_news_stations lookup table for local news feature

-- ============================================================================
-- Local News Stations Table
-- Contains known local TV station call signs and their locations
-- ============================================================================
CREATE TABLE IF NOT EXISTS local_news_stations (
    id SERIAL PRIMARY KEY,
    call_sign VARCHAR(10) NOT NULL,          -- e.g., "KSAZ", "KPHO"
    network VARCHAR(20) NOT NULL,            -- e.g., "FOX", "CBS", "NBC", "ABC", "PBS"
    city VARCHAR(100) NOT NULL,              -- e.g., "Phoenix"
    state VARCHAR(100) NOT NULL,             -- e.g., "Arizona"
    state_abbrev VARCHAR(2) NOT NULL,        -- e.g., "AZ"
    channel_number VARCHAR(10),              -- e.g., "10", "5"
    dma_rank INTEGER,                        -- Designated Market Area rank
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(call_sign)
);

CREATE INDEX IF NOT EXISTS idx_local_news_stations_state ON local_news_stations(state_abbrev);
CREATE INDEX IF NOT EXISTS idx_local_news_stations_city ON local_news_stations(LOWER(city));

-- ============================================================================
-- Seed data for Arizona (starting point)
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Phoenix DMA
('KSAZ', 'FOX', 'Phoenix', 'Arizona', 'AZ', '10'),
('KPHO', 'CBS', 'Phoenix', 'Arizona', 'AZ', '5'),
('KNXV', 'ABC', 'Phoenix', 'Arizona', 'AZ', '15'),
('KPNX', 'NBC', 'Phoenix', 'Arizona', 'AZ', '12'),
('KAET', 'PBS', 'Phoenix', 'Arizona', 'AZ', '8'),
('KTVK', 'IND', 'Phoenix', 'Arizona', 'AZ', '3'),
('KUTP', 'MNT', 'Phoenix', 'Arizona', 'AZ', '45'),
('KASW', 'CW', 'Phoenix', 'Arizona', 'AZ', '61'),
('KTVW', 'UNI', 'Phoenix', 'Arizona', 'AZ', '33'),
('KFPH', 'UNM', 'Phoenix', 'Arizona', 'AZ', '35'),
-- Tucson DMA
('KOLD', 'CBS', 'Tucson', 'Arizona', 'AZ', '13'),
('KGUN', 'ABC', 'Tucson', 'Arizona', 'AZ', '9'),
('KVOA', 'NBC', 'Tucson', 'Arizona', 'AZ', '4'),
('KMSB', 'FOX', 'Tucson', 'Arizona', 'AZ', '11'),
('KUAT', 'PBS', 'Tucson', 'Arizona', 'AZ', '6'),
-- Yuma DMA
('KYMA', 'NBC', 'Yuma', 'Arizona', 'AZ', '11'),
('KECY', 'FOX', 'Yuma', 'Arizona', 'AZ', '9')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- California stations (major markets)
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Los Angeles DMA
('KABC', 'ABC', 'Los Angeles', 'California', 'CA', '7'),
('KCBS', 'CBS', 'Los Angeles', 'California', 'CA', '2'),
('KNBC', 'NBC', 'Los Angeles', 'California', 'CA', '4'),
('KTTV', 'FOX', 'Los Angeles', 'California', 'CA', '11'),
('KTLA', 'CW', 'Los Angeles', 'California', 'CA', '5'),
('KCET', 'PBS', 'Los Angeles', 'California', 'CA', '28'),
('KMEX', 'UNI', 'Los Angeles', 'California', 'CA', '34'),
-- San Francisco DMA
('KGO', 'ABC', 'San Francisco', 'California', 'CA', '7'),
('KPIX', 'CBS', 'San Francisco', 'California', 'CA', '5'),
('KNTV', 'NBC', 'San Francisco', 'California', 'CA', '11'),
('KTVU', 'FOX', 'San Francisco', 'California', 'CA', '2'),
('KQED', 'PBS', 'San Francisco', 'California', 'CA', '9'),
-- San Diego DMA
('KFMB', 'CBS', 'San Diego', 'California', 'CA', '8'),
('KNSD', 'NBC', 'San Diego', 'California', 'CA', '39'),
('KGTV', 'ABC', 'San Diego', 'California', 'CA', '10'),
('KSWB', 'FOX', 'San Diego', 'California', 'CA', '69'),
-- Sacramento DMA
('KXTV', 'ABC', 'Sacramento', 'California', 'CA', '10'),
('KOVR', 'CBS', 'Sacramento', 'California', 'CA', '13'),
('KCRA', 'NBC', 'Sacramento', 'California', 'CA', '3'),
('KTXL', 'FOX', 'Sacramento', 'California', 'CA', '40'),
-- Fresno DMA
('KFSN', 'ABC', 'Fresno', 'California', 'CA', '30'),
('KGPE', 'CBS', 'Fresno', 'California', 'CA', '47'),
('KSEE', 'NBC', 'Fresno', 'California', 'CA', '24'),
('KMPH', 'FOX', 'Fresno', 'California', 'CA', '26')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Texas stations (major markets)
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Dallas-Fort Worth DMA
('WFAA', 'ABC', 'Dallas', 'Texas', 'TX', '8'),
('KTVT', 'CBS', 'Dallas', 'Texas', 'TX', '11'),
('KXAS', 'NBC', 'Dallas', 'Texas', 'TX', '5'),
('KDFW', 'FOX', 'Dallas', 'Texas', 'TX', '4'),
('KERA', 'PBS', 'Dallas', 'Texas', 'TX', '13'),
-- Houston DMA
('KTRK', 'ABC', 'Houston', 'Texas', 'TX', '13'),
('KHOU', 'CBS', 'Houston', 'Texas', 'TX', '11'),
('KPRC', 'NBC', 'Houston', 'Texas', 'TX', '2'),
('KRIV', 'FOX', 'Houston', 'Texas', 'TX', '26'),
('KUHT', 'PBS', 'Houston', 'Texas', 'TX', '8'),
-- San Antonio DMA
('KSAT', 'ABC', 'San Antonio', 'Texas', 'TX', '12'),
('KENS', 'CBS', 'San Antonio', 'Texas', 'TX', '5'),
('WOAI', 'NBC', 'San Antonio', 'Texas', 'TX', '4'),
('KABB', 'FOX', 'San Antonio', 'Texas', 'TX', '29'),
-- Austin DMA
('KVUE', 'ABC', 'Austin', 'Texas', 'TX', '24'),
('KEYE', 'CBS', 'Austin', 'Texas', 'TX', '42'),
('KXAN', 'NBC', 'Austin', 'Texas', 'TX', '36'),
('KTBC', 'FOX', 'Austin', 'Texas', 'TX', '7')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- New York stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WABC', 'ABC', 'New York', 'New York', 'NY', '7'),
('WCBS', 'CBS', 'New York', 'New York', 'NY', '2'),
('WNBC', 'NBC', 'New York', 'New York', 'NY', '4'),
('WNYW', 'FOX', 'New York', 'New York', 'NY', '5'),
('WPIX', 'CW', 'New York', 'New York', 'NY', '11'),
('WNET', 'PBS', 'New York', 'New York', 'NY', '13'),
-- Buffalo
('WKBW', 'ABC', 'Buffalo', 'New York', 'NY', '7'),
('WIVB', 'CBS', 'Buffalo', 'New York', 'NY', '4'),
('WGRZ', 'NBC', 'Buffalo', 'New York', 'NY', '2')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Florida stations (major markets)
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Miami DMA
('WPLG', 'ABC', 'Miami', 'Florida', 'FL', '10'),
('WFOR', 'CBS', 'Miami', 'Florida', 'FL', '4'),
('WTVJ', 'NBC', 'Miami', 'Florida', 'FL', '6'),
('WSVN', 'FOX', 'Miami', 'Florida', 'FL', '7'),
-- Tampa DMA
('WFTS', 'ABC', 'Tampa', 'Florida', 'FL', '28'),
('WTSP', 'CBS', 'Tampa', 'Florida', 'FL', '10'),
('WFLA', 'NBC', 'Tampa', 'Florida', 'FL', '8'),
('WTVT', 'FOX', 'Tampa', 'Florida', 'FL', '13'),
-- Orlando DMA
('WFTV', 'ABC', 'Orlando', 'Florida', 'FL', '9'),
('WKMG', 'CBS', 'Orlando', 'Florida', 'FL', '6'),
('WESH', 'NBC', 'Orlando', 'Florida', 'FL', '2'),
('WOFL', 'FOX', 'Orlando', 'Florida', 'FL', '35'),
-- Jacksonville DMA
('WJXX', 'ABC', 'Jacksonville', 'Florida', 'FL', '25'),
('WJAX', 'CBS', 'Jacksonville', 'Florida', 'FL', '47'),
('WTLV', 'NBC', 'Jacksonville', 'Florida', 'FL', '12'),
('WFOX', 'FOX', 'Jacksonville', 'Florida', 'FL', '30')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Illinois stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WLS', 'ABC', 'Chicago', 'Illinois', 'IL', '7'),
('WBBM', 'CBS', 'Chicago', 'Illinois', 'IL', '2'),
('WMAQ', 'NBC', 'Chicago', 'Illinois', 'IL', '5'),
('WFLD', 'FOX', 'Chicago', 'Illinois', 'IL', '32'),
('WTTW', 'PBS', 'Chicago', 'Illinois', 'IL', '11'),
('WGN', 'IND', 'Chicago', 'Illinois', 'IL', '9')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Pennsylvania stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WPVI', 'ABC', 'Philadelphia', 'Pennsylvania', 'PA', '6'),
('KYW', 'CBS', 'Philadelphia', 'Pennsylvania', 'PA', '3'),
('WCAU', 'NBC', 'Philadelphia', 'Pennsylvania', 'PA', '10'),
('WTXF', 'FOX', 'Philadelphia', 'Pennsylvania', 'PA', '29'),
('WHYY', 'PBS', 'Philadelphia', 'Pennsylvania', 'PA', '12'),
-- Pittsburgh
('WTAE', 'ABC', 'Pittsburgh', 'Pennsylvania', 'PA', '4'),
('KDKA', 'CBS', 'Pittsburgh', 'Pennsylvania', 'PA', '2'),
('WPXI', 'NBC', 'Pittsburgh', 'Pennsylvania', 'PA', '11'),
('WPGH', 'FOX', 'Pittsburgh', 'Pennsylvania', 'PA', '53')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Georgia stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WSB', 'ABC', 'Atlanta', 'Georgia', 'GA', '2'),
('WGCL', 'CBS', 'Atlanta', 'Georgia', 'GA', '46'),
('WXIA', 'NBC', 'Atlanta', 'Georgia', 'GA', '11'),
('WAGA', 'FOX', 'Atlanta', 'Georgia', 'GA', '5'),
('WPBA', 'PBS', 'Atlanta', 'Georgia', 'GA', '30')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Ohio stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Cleveland
('WEWS', 'ABC', 'Cleveland', 'Ohio', 'OH', '5'),
('WOIO', 'CBS', 'Cleveland', 'Ohio', 'OH', '19'),
('WKYC', 'NBC', 'Cleveland', 'Ohio', 'OH', '3'),
('WJW', 'FOX', 'Cleveland', 'Ohio', 'OH', '8'),
-- Columbus
('WSYX', 'ABC', 'Columbus', 'Ohio', 'OH', '6'),
('WBNS', 'CBS', 'Columbus', 'Ohio', 'OH', '10'),
('WCMH', 'NBC', 'Columbus', 'Ohio', 'OH', '4'),
('WTTE', 'FOX', 'Columbus', 'Ohio', 'OH', '28'),
-- Cincinnati
('WCPO', 'ABC', 'Cincinnati', 'Ohio', 'OH', '9'),
('WKRC', 'CBS', 'Cincinnati', 'Ohio', 'OH', '12'),
('WLWT', 'NBC', 'Cincinnati', 'Ohio', 'OH', '5'),
('WXIX', 'FOX', 'Cincinnati', 'Ohio', 'OH', '19')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Washington state stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('KOMO', 'ABC', 'Seattle', 'Washington', 'WA', '4'),
('KIRO', 'CBS', 'Seattle', 'Washington', 'WA', '7'),
('KING', 'NBC', 'Seattle', 'Washington', 'WA', '5'),
('KCPQ', 'FOX', 'Seattle', 'Washington', 'WA', '13'),
('KCTS', 'PBS', 'Seattle', 'Washington', 'WA', '9')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Colorado stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('KMGH', 'ABC', 'Denver', 'Colorado', 'CO', '7'),
('KCNC', 'CBS', 'Denver', 'Colorado', 'CO', '4'),
('KUSA', 'NBC', 'Denver', 'Colorado', 'CO', '9'),
('KDVR', 'FOX', 'Denver', 'Colorado', 'CO', '31'),
('KRMA', 'PBS', 'Denver', 'Colorado', 'CO', '6')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Massachusetts stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WCVB', 'ABC', 'Boston', 'Massachusetts', 'MA', '5'),
('WBZ', 'CBS', 'Boston', 'Massachusetts', 'MA', '4'),
('WBTS', 'NBC', 'Boston', 'Massachusetts', 'MA', '10'),
('WFXT', 'FOX', 'Boston', 'Massachusetts', 'MA', '25'),
('WGBH', 'PBS', 'Boston', 'Massachusetts', 'MA', '2')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Michigan stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('WXYZ', 'ABC', 'Detroit', 'Michigan', 'MI', '7'),
('WWJ', 'CBS', 'Detroit', 'Michigan', 'MI', '62'),
('WDIV', 'NBC', 'Detroit', 'Michigan', 'MI', '4'),
('WJBK', 'FOX', 'Detroit', 'Michigan', 'MI', '2'),
('WTVS', 'PBS', 'Detroit', 'Michigan', 'MI', '56')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Minnesota stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('KSTP', 'ABC', 'Minneapolis', 'Minnesota', 'MN', '5'),
('WCCO', 'CBS', 'Minneapolis', 'Minnesota', 'MN', '4'),
('KARE', 'NBC', 'Minneapolis', 'Minnesota', 'MN', '11'),
('KMSP', 'FOX', 'Minneapolis', 'Minnesota', 'MN', '9'),
('TPT', 'PBS', 'Minneapolis', 'Minnesota', 'MN', '2')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- Nevada stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
('KTNV', 'ABC', 'Las Vegas', 'Nevada', 'NV', '13'),
('KLAS', 'CBS', 'Las Vegas', 'Nevada', 'NV', '8'),
('KVBC', 'NBC', 'Las Vegas', 'Nevada', 'NV', '3'),
('KVVU', 'FOX', 'Las Vegas', 'Nevada', 'NV', '5')
ON CONFLICT (call_sign) DO NOTHING;

-- ============================================================================
-- North Carolina stations
-- ============================================================================
INSERT INTO local_news_stations (call_sign, network, city, state, state_abbrev, channel_number) VALUES
-- Charlotte
('WSOC', 'ABC', 'Charlotte', 'North Carolina', 'NC', '9'),
('WBTV', 'CBS', 'Charlotte', 'North Carolina', 'NC', '3'),
('WCNC', 'NBC', 'Charlotte', 'North Carolina', 'NC', '36'),
('WJZY', 'FOX', 'Charlotte', 'North Carolina', 'NC', '46'),
-- Raleigh
('WTVD', 'ABC', 'Raleigh', 'North Carolina', 'NC', '11'),
('WNCN', 'CBS', 'Raleigh', 'North Carolina', 'NC', '17'),
('WRAL', 'NBC', 'Raleigh', 'North Carolina', 'NC', '5'),
('WRAZ', 'FOX', 'Raleigh', 'North Carolina', 'NC', '50')
ON CONFLICT (call_sign) DO NOTHING;

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES ('014', 'Add local_news_stations lookup table')
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE local_news_stations IS 'Lookup table of known local TV station call signs and locations';
