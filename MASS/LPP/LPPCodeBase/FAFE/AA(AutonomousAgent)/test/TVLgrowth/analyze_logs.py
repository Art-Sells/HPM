#!/usr/bin/env python3
import json
import sys
from pathlib import Path
from collections import defaultdict

def analyze_log_file(filepath):
    """Analyze a single NDJSON log file"""
    results = {
        'file': Path(filepath).name,
        'entries': 0,
        'total_opportunities': 0,
        'unique_pairs': set(),
        'opportunities': [],
        'profit_range': None,
        'venues': set(),
    }
    
    try:
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    results['entries'] += 1
                    mispricings = data.get('mispricings', [])
                    results['total_opportunities'] += len(mispricings)
                    
                    for opp in mispricings:
                        results['unique_pairs'].add(opp.get('pairId', 'UNKNOWN'))
                        results['venues'].add(opp.get('buyVenue', ''))
                        results['venues'].add(opp.get('sellVenue', ''))
                        results['opportunities'].append({
                            'pairId': opp.get('pairId'),
                            'borrowToken': opp.get('borrowToken'),
                            'buyVenue': opp.get('buyVenue'),
                            'sellVenue': opp.get('sellVenue'),
                            'netProfitUsd': opp.get('expectedProfitUsd', opp.get('netProfitUsd', 0)),
                            'edgeBps': opp.get('edgeBps', 0),
                            'timestamp': data.get('timestamp', 0),
                        })
                except json.JSONDecodeError:
                    continue
        
        if results['opportunities']:
            profits = [o['netProfitUsd'] for o in results['opportunities']]
            results['profit_range'] = (min(profits), max(profits))
        
        results['unique_pairs'] = sorted(results['unique_pairs'])
        results['venues'] = sorted(results['venues'])
        
    except Exception as e:
        results['error'] = str(e)
    
    return results

def main():
    log_dir = Path(__file__).parent / 'logs'
    
    all_results = []
    
    # Analyze all NDJSON files
    for pattern in ['tvl-growth/*.ndjson', 'tvl-growth-live/*.ndjson']:
        for filepath in log_dir.glob(pattern):
            results = analyze_log_file(filepath)
            all_results.append(results)
    
    # Print summary
    print("=" * 80)
    print("TVL GROWTH LOG ANALYSIS")
    print("=" * 80)
    print()
    
    for results in all_results:
        print(f"📁 {results['file']}")
        print(f"   Entries: {results['entries']}")
        print(f"   Total Opportunities: {results['total_opportunities']}")
        print(f"   Unique Pairs: {', '.join(results['unique_pairs']) if results['unique_pairs'] else 'None'}")
        
        if results['profit_range']:
            print(f"   Profit Range: ${results['profit_range'][0]:,.2f} - ${results['profit_range'][1]:,.2f}")
        
        if results['opportunities']:
            print(f"   Top Opportunities:")
            # Sort by profit, show top 5
            sorted_opps = sorted(results['opportunities'], key=lambda x: x['netProfitUsd'], reverse=True)[:5]
            for i, opp in enumerate(sorted_opps, 1):
                print(f"      {i}. {opp['pairId']} | Borrow: {opp['borrowToken']} | "
                      f"Profit: ${opp['netProfitUsd']:,.2f} | "
                      f"Buy: {opp['buyVenue'][:30]} | Sell: {opp['sellVenue'][:30]}")
        
        if results.get('error'):
            print(f"   ⚠️  Error: {results['error']}")
        
        print()
    
    # Compare opportunities across files
    print("=" * 80)
    print("OPPORTUNITY COMPARISON")
    print("=" * 80)
    print()
    
    # Group by pair
    pair_opportunities = defaultdict(list)
    for results in all_results:
        for opp in results['opportunities']:
            key = f"{opp['pairId']}|{opp['borrowToken']}"
            pair_opportunities[key].append({
                'file': results['file'],
                'profit': opp['netProfitUsd'],
                'buyVenue': opp['buyVenue'],
                'sellVenue': opp['sellVenue'],
            })
    
    print("Opportunities by Pair/Token:")
    for key, opps in sorted(pair_opportunities.items()):
        pair, token = key.split('|')
        profits = [o['profit'] for o in opps]
        print(f"\n  {pair} | Borrow: {token}")
        print(f"    Found in {len(opps)} log file(s)")
        print(f"    Profit range: ${min(profits):,.2f} - ${max(profits):,.2f}")
        print(f"    Average profit: ${sum(profits)/len(profits):,.2f}")
        for opp in opps:
            print(f"      - {opp['file']}: ${opp['profit']:,.2f} ({opp['buyVenue'][:20]} → {opp['sellVenue'][:20]})")

if __name__ == '__main__':
    main()

