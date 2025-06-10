import pandas as pd
import numpy as np

def generate_parameter_sets(n=500, seed=42):
    np.random.seed(seed)
    data = {
        "p": np.random.randint(6, 11, n),
        "atr_p": np.random.randint(3, 7, n),
        "mult": np.round(np.random.uniform(0.25, 0.6, n), 2),
        "supertrend_atr": np.random.randint(4, 8, n),
        "supertrend_factor": np.round(np.random.uniform(1.2, 2.0, n), 2),
        "atrnowinput": np.random.randint(2, 5, n),
        "atrAvginput": np.random.randint(8, 15, n),
        "volatilityMultiplier": np.round(np.random.uniform(0.5, 1.0, n), 2),
        "bodyratioMult": np.round(np.random.uniform(0.55, 0.9, n), 2),
        "structureLookback": np.random.randint(20, 35, n),
        "bufferMult": np.round(np.random.uniform(0.3, 1.2, n), 2),
        "maxSlDistance": np.round(np.random.uniform(5, 120, n), 2),
        "isStrongTrendMult": np.random.randint(9, 20, n)
    }
    return pd.DataFrame(data)

# Save each file
generate_parameter_sets(seed=101).to_csv("ethusdt_5m.csv", index=False)
generate_parameter_sets(seed=202).to_csv("galausdt_5m.csv", index=False)
generate_parameter_sets(seed=303).to_csv("btcusdt_5m.csv", index=False)
