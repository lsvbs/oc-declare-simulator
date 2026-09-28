"""Regenerate golden values by executing the supplied notebook, not the app port.

Run from the repository root with the reference notebook path as the argument.
Only selected calculation cells run; file dialogs and plotting cells do not.
"""
import ast
import contextlib
import hashlib
import io
import json
import math
from pathlib import Path
import sys

import numpy as np
import pandas as pd


def safe(v):
    if isinstance(v, dict):
        return {str(k): safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [safe(x) for x in v]
    if isinstance(v, np.generic):
        return safe(v.item())
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    return v


def generate(notebook):
    root = Path(__file__).parent / 'fixtures' / 'notebook_evaluation'
    cells = json.loads(notebook.read_text())['cells']
    for mode, anchors in [(m, []) for m in ('minimum', 'p25', 'p50', 'mean')] + [
            ('minimum', [{'name': 'A', 'mean_seconds': 12, 'std_seconds': 2}])]:
        ns = {'INPUT_LOG': str(root/'input.json'), 'SIMULATED_LOG': str(root/'simulated.json'),
              'OCDECLARE_MODEL': str(root/'model.json')}
        with contextlib.redirect_stdout(io.StringIO()):
            for i in (9, 11, 14, 16, 18, 20, 23, 25, 27):
                tree = ast.parse(''.join(cells[i]['source']))
                if i == 14:
                    for node in tree.body:
                        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
                            if node.targets[0].id == 'SERVICE_TIME_MODE':
                                node.value = ast.Constant(mode)
                            elif node.targets[0].id == 'ANCHOR_ACTIVITIES':
                                node.value = ast.parse(repr(anchors), mode='eval').body
                            elif node.targets[0].id == 'TIMING_DISCOVERY_PATH':
                                local = Path(__file__).resolve().parents[1]/'src/ParameterDiscovery/timediscovery.py'
                                node.value = ast.parse(f'Path({str(local)!r})', mode='eval').body
                exec(compile(ast.fix_missing_locations(tree), f'notebook-cell-{i}', 'exec'), ns)
        expected = {'reference_sha256': hashlib.sha256(notebook.read_bytes()).hexdigest(),
                    'conformance': {}, 'service_times': ns['SERVICE_TIMES'],
                    'wmape_mean': ns['wmape_mean'], 'wmape_std': ns['wmape_std'],
                    'wmape_details': ns['service'].to_dict('records'),
                    'w1_result': ns['w1_result'], 'w1_details': ns['wf'].to_dict('records'),
                    'w1_excluded': ns['w1_excluded'].to_dict('records'),
                    'ngd_result': ns['ngd_result'], 'ngd_details': ns['ngd_table'].to_dict('records'),
                    'kl_activities': ns['kl_activities'], 'kl_object_types': ns['kl_object_types'].to_dict('records')}
        for role, short in [('input', 'in'), ('simulated', 'sim')]:
            key = 'input' if role == 'input' else 'sim'
            expected['conformance'][role] = {
                'confidence': ns['summary_'+short], 'violations': ns['violation_summary_'+key],
                'constraints': ns['violations_by_constraint_'+key].to_dict('records'),
                'coverage': ns['cov_'+key], 'coverage_details': ns['det_'+key].to_dict('records')}
        name = mode + ('_anchors' if anchors else '')
        (root/f'expected_{name}.json').write_text(json.dumps(safe(expected), indent=2, allow_nan=False)+'\n')
        print(f'Generated {name} from notebook')


if __name__ == '__main__':
    generate(Path(sys.argv[1]))
