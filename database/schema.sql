-- Interior Design Items Table
CREATE TABLE interior_items (
  id SERIAL PRIMARY KEY,
  sl_no INTEGER,
  item_name VARCHAR(255) NOT NULL,
  item_image TEXT,
  item_details TEXT,
  variation_name VARCHAR(255),
  base_material VARCHAR(255),
  finish_material VARCHAR(255),
  suggestive_areas TEXT,
  packages VARCHAR(100),
  length_ft DECIMAL(8,2),
  width_ft DECIMAL(8,2),
  height_ft DECIMAL(8,2),
  price_rule VARCHAR(50),
  rate_inr VARCHAR(100),
  price_inr INTEGER,
  preferred_theme TEXT,
  item_description TEXT,
  item_link TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better search performance
CREATE INDEX idx_interior_items_name ON interior_items USING GIN (to_tsvector('english', item_name));
CREATE INDEX idx_interior_items_description ON interior_items USING GIN (to_tsvector('english', item_description));
CREATE INDEX idx_interior_items_areas ON interior_items (suggestive_areas);
CREATE INDEX idx_interior_items_theme ON interior_items (preferred_theme);
CREATE INDEX idx_interior_items_package ON interior_items (packages);
CREATE INDEX idx_interior_items_price ON interior_items (price_inr);

-- Quotations Table
CREATE TABLE quotations (
  id SERIAL PRIMARY KEY,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  customer_phone VARCHAR(20),
  project_name VARCHAR(255),
  project_area VARCHAR(100),
  project_theme VARCHAR(100),
  total_amount INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'draft',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Quotation Items Table (junction table for quotations and items)
CREATE TABLE quotation_items (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES interior_items(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 1,
  unit_price INTEGER,
  total_price INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chat Sessions Table
CREATE TABLE chat_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  customer_info JSONB,
  requirements JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chat Messages Table
CREATE TABLE chat_messages (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  message_type VARCHAR(20) NOT NULL, -- 'user' or 'bot'
  message_text TEXT NOT NULL,
  items_suggested JSONB,
  total_estimate INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE interior_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (adjust based on your security needs)
CREATE POLICY "Allow public read access on interior_items" ON interior_items
  FOR SELECT USING (true);

CREATE POLICY "Allow public insert access on quotations" ON quotations
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read access on quotations" ON quotations
  FOR SELECT USING (true);

CREATE POLICY "Allow public insert access on quotation_items" ON quotation_items
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read access on quotation_items" ON quotation_items
  FOR SELECT USING (true);

CREATE POLICY "Allow public access on chat_sessions" ON chat_sessions
  FOR ALL USING (true);

CREATE POLICY "Allow public access on chat_messages" ON chat_messages
  FOR ALL USING (true);
