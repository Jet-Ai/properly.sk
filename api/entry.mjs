import { DurableObject } from "cloudflare:workers";
import worker, { RefreshCoordinator as Coordinator } from "./worker.mjs";

export class RefreshCoordinator extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.coordinator = new Coordinator(state, env);
  }

  fetch(request) {
    return this.coordinator.fetch(request);
  }
}

export default worker;
