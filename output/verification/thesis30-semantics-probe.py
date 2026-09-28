"""Read-only diagnostic examples for the thesis-30 review; run with PYTHONPATH=. from the project root.

These report the current violations rather than asserting that they are correct.
"""
import json
from datetime import datetime, timedelta, timezone
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
from Backend.src.Simulation.Engine.candidategeneration import Candidate
from Backend.src.Simulation.Engine.semantics import check_all_constraints
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict
from Backend.src.Evaluation import notebook_measures as nm

base=datetime(2025,1,1,tzinfo=timezone.utc)
results=[]
def check_precedence_case(name, types, inv, history, nmin=1, nmax=None):
    st=SimulationState()
    ids=[st.add_object(t).object_id for t in types]
    for sec,(activity,indices) in enumerate(history,1):
        st.record_event(activity,[ids[i] for i in indices],base+timedelta(seconds=sec))
    bindings=[{'object_type':t,'min_count':types.count(t),'max_count':types.count(t)} for t in dict.fromkeys(types)]
    c={'type':'precedence','arc_type':'EP','from':'B','to':'A','counts':[nmin,nmax],
       'nmin':nmin,'nmax':nmax,'involvement_per_label':inv}
    raw={'constraint_orientation':'arc','object_types':[{'name':t} for t in dict.fromkeys(types)],
         'activities':[{'name':'B','bindings':bindings}], 'constraints':[c],
         'activity_durations':{'B':{'dist_type':'fixed','mean_seconds':1}}}
    model=parse_ocdeclare_dict(raw)
    admitted=check_all_constraints(model,Candidate('B',ids),st)
    sim=Simulator(model,SimulationConfig(seed=7,max_steps=len(history)+1,start_timestamp=base+timedelta(seconds=10),start_policy=StartPolicy(['B'])))
    sim.run(st)
    log=build_ocel2_dict(st)
    table,summary=nm.evaluate_confidence(nm.build_index(log),nm.load_confidence_model(raw))
    results.append({'case':name,'admission_allowed':admitted,'executed':[e.activity_name for e in st.executed_events],
                    'B_conformance':float(table.iloc[0]['confidence']), 'violating_B_events':int(table.iloc[0]['n_violating'])})

check_precedence_case('EP Cartesian Each: missing cross-pairs', ['Order','Order','Item','Item'],{'Order':'each','Item':'each'}, [('A',[0,2]),('A',[1,3])])
check_precedence_case('EP nmin=2: second object has only one A', ['Order','Order'],{'Order':'each'}, [('A',[0]),('A',[0]),('A',[1])],2)
check_precedence_case('EP nmax=1: two preceding A events', ['Order'],{'Order':'each'}, [('A',[0]),('A',[0])],1,1)

for ar in ['DF','DP']:
    arc={'from':'A' if ar=='DF' else 'B','to':'B' if ar=='DF' else 'A','arc_type':ar,'counts':[1,None], 'label':{'each':[{'object_type':'Order'}]}}
    model=parse_ocdeclare_list([arc])
    st=SimulationState(); oid=st.add_object('Order').object_id
    if ar=='DF':
        st.record_event('A',[oid],base)
        candidate=Candidate('Other',[oid])
    else:
        candidate=Candidate('B',[oid])
    results.append({'case':ar+' imported arc-list','parsed_type':model.constraints[0].constraint_type,
                    'invalid_candidate_allowed':check_all_constraints(model,candidate,st)})

for ar in ['EF','EP','AS','DF','DP']:
    raw={'constraint_orientation':'arc','constraints':[{'arc_type':ar,'from':'A','to':'B','counts':[1,None], 'involvement_per_label':{'Order':'each'}}]}
    try:
        nm.load_confidence_model(raw)
        outcome='accepted'
    except NotImplementedError as ex:
        outcome=str(ex)
    results.append({'case':'evaluation '+ar,'result':outcome})
print(json.dumps(results,indent=2))
