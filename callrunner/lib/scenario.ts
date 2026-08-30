import path from 'path';
import { ASSETS_DIR } from './config';
import { sortedWav } from './wav';
import type { Scenario } from './types';

export function loadAssetsScenario(dir = ASSETS_DIR): Scenario {
  return {
    name: path.basename(dir) || 'assets',
    clips: sortedWav(dir),
  };
}
