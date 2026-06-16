# Declarative OC Simulator Frontend

A React-based web interface for running object-centric process simulations with a two-step workflow.

## Two-Step Workflow

### Step 1: Parameter Discovery
1. Select an event log file
2. Click "Run Discovery"
3. View discovered parameters:
   - Activities found in the log
   - Transition probabilities
   - Most likely transitions
   - Event and object statistics

### Step 2: Run Simulation
1. Select OC-Declare model file
2. Choose start activity from dropdown (populated from discovery)
3. Configure max steps and random seed
4. Click "Run Simulation"
5. View results and download event log

## Key Features

- 📊 **Separate Discovery Phase**: Parameters are discovered once and reused
- 🎯 **Activity Dropdown**: Start activity is selected from discovered activities
- 📈 **Visual Flow Chart**: See process flow with transition frequencies
- 🔄 **Two-Phase Workflow**: Clear separation between discovery and simulation
- 📥 **Download Results**: Export generated OCEL event logs

## Setup

### Backend Setup

1. Install Python dependencies:
```bash
cd Backend
pip install -r requirements.txt
```

2. Start the Flask server:
```bash
python server.py
```

The backend will run on http://localhost:5000

### Frontend Setup

1. Install Node.js dependencies:
```bash
cd Frontend
npm install
```

2. Start the development server:
```bash
npm run dev
```

The frontend will run on http://localhost:3000

## Usage

1. **Start both servers** (backend and frontend)
2. **Open your browser** to http://localhost:3000
3. **Step 1 - Discovery:**
   - Select event log file
   - Click "Run Discovery"
   - Review discovered activities and statistics
4. **Step 2 - Simulation:**
   - Select OC-Declare model
   - Choose start activity from dropdown
   - Set simulation parameters
   - Click "Run Simulation"
5. **View results** including flow chart and download event log

## Architecture

```
Step 1: Discovery
Frontend → POST /api/discover → Backend
         ← Discovery Results ←

Step 2: Simulation  
Frontend → POST /api/simulate → Backend (uses cached discovery)
         ← Simulation Results ←
```

## API Endpoints

- `GET /api/files` - List available models and event logs
- `POST /api/discover` - Run parameter discovery on event log
- `GET /api/activities?eventLogFile=<file>` - Get discovered activities
- `POST /api/simulate` - Run simulation with cached discovery results
- `GET /api/download/<filename>` - Download generated event log
- `GET /api/health` - Health check

## Benefits of Two-Step Workflow

1. **Faster iterations**: Discovery runs once, simulation can run multiple times
2. **Better understanding**: See what was discovered before simulating
3. **Clear dependencies**: Simulation requires completed discovery
4. **Flexible experimentation**: Change simulation config without re-discovery
5. **User-friendly**: Dropdown menus instead of free text for activities
