"""跑候选池：python tools/run_candidates.py [-v]"""

import sys
from verify_levels import parse, solve, show
from level_candidates import CANDIDATES

if __name__ == '__main__':
    verbose = '-v' in sys.argv
    for name, text in CANDIDATES.items():
        show(name, text, verbose=verbose)
