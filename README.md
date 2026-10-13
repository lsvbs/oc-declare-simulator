# Declarative OC Simulator Frontend

A React-based web interface for running object-centric process simulations with a two-step workflow.

## Setup

### Prerequisites
Before you begin, make sure the following is installed on your machine:
- **Python 3.10 or higher** - 
- **Node.js or higher** (includes npm) - 

You can verify by:
```bash
python3 -- version
node --version
```

### Backend Setup

1. Install Python dependencies:
```bash
cd Backend
pip install -r requirements.txt
```

2. Start the Flask server in a second terminal, keep previous terminal open:
```bash
python server.py
```

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

If successful, you should see "Running on http://localhost:3000"
The frontend will run on http://localhost:3000, Three-Step Workflow happens here.

## Three-Step Workflow

### Step 1: Parameter Discovery
1. Select an OCEL 2.0 json event log file
2. Click "Run Discovery" OR choose previously discovered OC-DECLARE json file
3. View discovered parameters and model in Base Model:
   - Activities found in the log
   - Transition probabilities
   - Most likely transitions
   - Event and object statistics

### Step 2: Run Simulation
1. Go to Simulation Tab
2. Optional: Set Starting Activities max count to limit simulation
3. Optional: Set Stop Conditions to limit simulation
4. Set Random Seed
5. Run Simulation
6. Optional: stop simulation run manually

### Step 3: Evaluation
1. Run Evaluation after Simulation stops
2. Go to Evaluation Tab to see evaluation results.

### Optional: Run Alternative Model
1. After running Simulation once on Base Model, Simulation run on Alternative Model possible
2. Click on Alternative Model Tab to edit model the same way as Base Model
3. In Simulation Tab: expand Show Alternative Model
4. Follow same steps to run from Base Model simulation but for Alternative Model


## Usage

1. **Start both servers in two different terminals** (backend and frontend)
2. **Open your browser** to http://localhost:3000
3. **See Three-Step Workflow**

## Limitations and future work
- Attributes/Qualifiers are placeholders and not considered during simulation.

