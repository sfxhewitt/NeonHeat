import type { NavNode, RoadGraph } from './nav';

const cache = new WeakMap<RoadGraph, (n: NavNode) => boolean>();

/**
 * A filter for RoadGraph.nearest that only accepts nodes on the largest
 * connected part of the road network. The generated city has short dead-end
 * stubs (driveways, alley ends) that are islands in the graph; routing from
 * one of those goes nowhere. Computed once per graph.
 */
export function mainNetwork(g: RoadGraph): (n: NavNode) => boolean {
  let f = cache.get(g);
  if (f) return f;
  const comp = new Int32Array(g.nodes.length).fill(-1);
  const stack: number[] = [];
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (const n of g.nodes) {
    if (comp[n.id]! >= 0) continue;
    comp[n.id] = c;
    stack.push(n.id);
    let size = 0;
    while (stack.length) {
      const id = stack.pop()!;
      size++;
      for (const l of g.nodes[id]!.links) {
        if (comp[l]! >= 0) continue;
        comp[l] = c;
        stack.push(l);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  f = (n: NavNode) => comp[n.id] === best;
  cache.set(g, f);
  return f;
}

/** The nearest node on the main road network. */
export function nearestMain(g: RoadGraph, x: number, z: number): NavNode {
  return g.nearest(x, z, mainNetwork(g));
}
