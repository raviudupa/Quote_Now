# Interior Design AI Quotation System

An intelligent chatbot system that helps interior designers generate accurate quotations for their customers based on a comprehensive database of furniture and design items.

## Features

- 🤖 **AI-Powered Chatbot**: Natural language processing to understand customer requirements
- 💰 **Instant Quotations**: Generate accurate price estimates based on real product data
- 🎨 **Style Matching**: Match products to customer's preferred themes and room types
- 📱 **Modern UI**: Beautiful Material-UI interface with responsive design
- 🔍 **Smart Search**: Advanced filtering by room, theme, budget, and package type
- 📊 **Real-time Results**: Instant product recommendations with pricing

## Tech Stack

- **Frontend**: React 18 + Vite + Material-UI
- **Backend**: Supabase (PostgreSQL database + Auth + API)
- **AI/ML**: Custom JavaScript-based AI service with RAG capabilities
- **Data**: 460+ IKEA furniture items with comprehensive metadata

## Quick Start

### 1. Prerequisites

- Node.js 18+ 
- Supabase account
- OpenAI API key (optional, for enhanced AI features)

### 2. Setup Supabase

1. Create a new Supabase project
2. Run the SQL schema from `database/schema.sql` in your Supabase SQL editor
3. Get your project URL and anon key from Settings > API

### 3. Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in your Supabase credentials:
```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_OPENAI_API_KEY=your_openai_api_key (optional)
```

### 4. Install Dependencies

```bash
cd interior-quotation-ai
npm install
```

### 5. Import CSV Data

Set environment variables for the import script:
```bash
export SUPABASE_URL=your_supabase_url
export SUPABASE_SERVICE_KEY=your_supabase_service_key
```

Run the import script:
```bash
node scripts/import-csv.js
```

### 6. Start Development Server

```bash
npm run dev
```

Visit `http://localhost:3000` to see your application!

## Usage

### Customer Interaction Examples

**Basic Room Design:**
- "I need furniture for my living room with a modern theme"
- "Show me bedroom furniture under ₹50,000"
- "I want premium bathroom fixtures in Scandinavian style"

**Specific Requirements:**
- "I need a 3-seat sofa, coffee table, and side tables for my living room"
- "Show me luxury dining furniture with traditional theme"
- "Budget-friendly bedroom set under ₹30,000"

### AI Features

The system intelligently:
- Extracts room types, themes, budget, and specific items from natural language
- Filters products based on multiple criteria
- Generates contextual responses with product recommendations
- Calculates total estimates automatically
- Suggests complementary items

## Database Schema

### Main Tables

- **interior_items**: Product catalog with 460+ items
- **quotations**: Customer quotation records
- **quotation_items**: Line items for each quotation
- **chat_sessions**: Chat conversation tracking
- **chat_messages**: Individual chat messages

### Key Features

- Full-text search on product names and descriptions
- Indexed filtering by area, theme, package, and price
- Row Level Security (RLS) enabled
- Optimized for fast queries

## Architecture

```
Frontend (React + Material-UI)
    ↓
AI Service (JavaScript-based RAG)
    ↓
Supabase API (PostgreSQL + REST)
    ↓
Product Database (460+ items)
```

## Customization

### Adding New Products

1. Update your CSV file with new items
2. Run the import script again
3. The system will automatically include new items in searches

### Enhancing AI Responses

1. Modify `src/services/aiService.js`
2. Add new requirement extraction patterns
3. Implement custom response generation logic
4. Integrate with OpenAI API for advanced NLP

### UI Customization

1. Update theme in `src/App.jsx`
2. Modify components in `src/components/`
3. Add new Material-UI components as needed

## Deployment

### Frontend Deployment

```bash
npm run build
# Deploy the 'dist' folder to your hosting service
```

### Database Setup

1. Your Supabase database is automatically hosted
2. Ensure RLS policies are configured correctly
3. Monitor usage and scale as needed

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues and questions:
1. Check the documentation
2. Review common issues in the code comments
3. Contact the development team

## License

This project is licensed under the MIT License.
