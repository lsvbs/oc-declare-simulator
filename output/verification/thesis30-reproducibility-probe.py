"""Run with fixed simulation seed and different PYTHONHASHSEED values to compare exports."""
import hashlib, json
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import Activity, ActivityDuration, ObjectBinding, ObjectType, StaticModel
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict
state=SimulationState()
for _ in range(8): state.add_object('Order')
model=StaticModel(activities=[Activity('Finish',[ObjectBinding('Order',1,1,deactivates=True)])],
 object_types=[ObjectType('Order')], activity_durations={'Finish':ActivityDuration(dist_type='lognormal',mean_seconds=10,std_seconds=5)},
 activity_concurrency={'Finish':1})
result=Simulator(model,SimulationConfig(max_steps=8,seed=42,start_policy=StartPolicy(['Finish']))).run(state)
payload=build_ocel2_dict(result)
print(json.dumps({'digest':hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest(),
 'objects_in_event_order':[e.object_ids for e in result.executed_events]}))
