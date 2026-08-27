import type { BaseEvent } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import type { Observable } from "rxjs";
import { defer, EMPTY, finalize, from, switchMap } from "rxjs";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../external/thread-store";
import type {
  CoworkerRouteResult,
  CoworkerRoutingService,
} from "../routing/service";
import {
  currentSlackExecution,
  type SlackExecution,
} from "./execution-context";

type RunAgentInput = Parameters<AbstractAgent["run"]>[0];

export type OpenBotChannelAgentDependencies = {
  routing: CoworkerRoutingService;
  store: ExternalThreadStore;
  resolver: ActorAgentResolver;
};

type ActiveRun = {
  inner?: AbstractAgent;
  aborted: boolean;
};

/**
 * A Channels-facing agent that pins a Slack thread to its first selected coworker.
 *
 * Slack identity stays in AsyncLocalStorage: the delegated AG-UI input is exactly the one that
 * Channels gave us, so none of the provider identity is exposed to a coworker or remote endpoint.
 */
export class OpenBotChannelAgent extends AbstractAgent {
  private readonly channelsThreadId: string;
  private readonly routing: CoworkerRoutingService;
  private readonly store: ExternalThreadStore;
  private readonly resolver: ActorAgentResolver;
  private active?: ActiveRun;

  constructor(channelsThreadId: string, deps: OpenBotChannelAgentDependencies) {
    super({ agentId: "openbot-slack", description: "OpenBot Slack router" });
    this.channelsThreadId = channelsThreadId;
    this.routing = deps.routing;
    this.store = deps.store;
    this.resolver = deps.resolver;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => {
      const execution = currentSlackExecution();
      execution.channelsThreadId = this.channelsThreadId;
      const active: ActiveRun = { aborted: false };
      this.active = active;

      return from(this.resolve(execution)).pipe(
        switchMap((target) => {
          // A later subscription replaced this run. Never retain or abort its target here.
          if (this.active !== active) return EMPTY;
          if (active.aborted) {
            target.abortRun();
            return EMPTY;
          }
          active.inner = target;
          return target.run(input);
        }),
        finalize(() => {
          active.inner = undefined;
          if (this.active === active) this.active = undefined;
        }),
      );
    });
  }

  clone(): OpenBotChannelAgent {
    return new OpenBotChannelAgent(this.channelsThreadId, {
      routing: this.routing,
      store: this.store,
      resolver: this.resolver,
    });
  }

  abortRun(): void {
    const active = this.active;
    if (active) {
      active.aborted = true;
      const inner = active.inner;
      active.inner = undefined;
      inner?.abortRun();
    }
    super.abortRun();
  }

  private async resolve(execution: SlackExecution): Promise<AbstractAgent> {
    let binding = await this.store.getByChannelsThreadId(this.channelsThreadId);
    if (!binding) {
      const route = await this.routing.route({
        actor: execution.actor,
        text: execution.messageText,
      });
      binding = await this.bindSelectedRoute(execution, route);
    }

    execution.agentId = binding.agentId;
    return this.resolver.resolveAgentForActor(execution.actor, binding.agentId);
  }

  private async bindSelectedRoute(
    execution: SlackExecution,
    route: CoworkerRouteResult,
  ): Promise<ExternalThreadBinding> {
    if (route.kind === "none") {
      throw new Error("No coworker is available to you.");
    }
    if (route.kind === "ambiguous") {
      throw new Error(`Name one coworker: ${route.names.join(", ")}.`);
    }

    return this.store.bind({
      channelsThreadId: this.channelsThreadId,
      provider: execution.provider,
      providerTenantId: execution.providerTenantId,
      providerConversationId: execution.providerConversationId,
      providerThreadId: execution.providerThreadId,
      agentId: route.agentId,
      agentName: route.name,
      createdByUserId: execution.actor.id,
    });
  }
}
