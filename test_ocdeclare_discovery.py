#!/usr/bin/env python3
"""
Test script for OC-Declare discovery algorithm
"""

import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model

def test_discovery():
    """Test OC-Declare discovery on sample OCEL log."""
    print("Testing OC-Declare Discovery Algorithm")
    print("=" * 50)
    
    # Test with sample OCEL 2.0 log
    log_path = 'src/Simulation/IO/input/eventlog/test_ocel_discovery.json'
    
    print(f"\n1. Testing with OCEL 2.0 log: {log_path}")
    
    result = discover_ocdeclare_model(
        event_log_path=log_path,
        min_support=0.7,
        min_confidence=0.85,
        noise_threshold=0.15,
        constraint_types={
            'precedence': True,
            'response': True
        },
        output_filename='test_discovered_model.json'
    )
    
    print(f"\n2. Discovery Statistics:")
    for key, value in result['stats'].items():
        print(f"   - {key}: {value}")
    
    print(f"\n3. Discovered Model Components:")
    print(f"   - Object Types: {result['model']['object_types']}")
    print(f"   - Activities: {[a['name'] for a in result['model']['activities']]}")
    print(f"   - Number of Constraints: {len(result['model']['constraints'])}")
    print(f"   - Number of O2O Rules: {len(result['model']['o2o_rules'])}")
    
    if result['model']['constraints']:
        print(f"\n4. Sample Constraints (first 5):")
        for i, constraint in enumerate(result['model']['constraints'][:5]):
            print(f"   {i+1}. {constraint['type']}: {constraint['source']} → {constraint['target']}")
            print(f"      Scope: {constraint['scope']['kind']} {constraint['scope']['object_type']}")
            print(f"      Support: {constraint['support']}, Confidence: {constraint['confidence']}")
    
    if result['model']['o2o_rules']:
        print(f"\n5. O2O Rules:")
        for rule in result['model']['o2o_rules']:
            print(f"   - {rule['source_type']} → {rule['target_type']}: "
                  f"min={rule['min_links']}, max={rule['max_links']}")
    
    print(f"\n6. Model saved to: src/Simulation/IO/input/ocdeclare/{result['output_file']}")
    print("\n" + "=" * 50)
    print("Test completed successfully!")
    
    return result


if __name__ == '__main__':
    try:
        result = test_discovery()
    except Exception as e:
        print(f"\nError during discovery: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
