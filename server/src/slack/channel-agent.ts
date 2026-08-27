import type { BaseEvent } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import {
  defer,
  EMPTY,
  finalize,
  from,
  Observable,
  Subject,
  switchMap,
  takeUntil,
  throwError,
} from "rxjs";
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
  started: boolean;
  cancelled: boolean;
  cancellation: Subject<void>;
};

/**
 * A Channels-facing agent that pins a Slack thread to its first selected coworker.
 *
 * Slack identity stays in AsyncLocalStorage: the delegated AG-UI input is exactly the one that
 * Channels gave us, so none of the provider identity is exposed to a coworker or remote endpoint.
 */
export class OpenBotChannelAgent extends AbstractAgent {
  private channelsThreadId: string;
  private routing: CoworkerRoutingService;
  private store: ExternalThreadStore;
  private resolver: ActorAgentResolver;
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
      if (this.active) {
        return throwError(
          () => new Error("OpenBot Slack agent is already running."),
        );
      }
      const execution = currentSlackExecution();
      execution.channelsThreadId = this.channelsThreadId;
      const active: ActiveRun = {
        started: false,
        cancelled: false,
        cancellation: new Subject<void>(),
      };
      this.active = active;

      const work = from(this.resolve(execution)).pipe(
        switchMap((target) => {
          if (active.cancelled || this.active !== active) return EMPTY;
          active.inner = target;
          active.started = true;
          return target.run(input);
        }),
        takeUntil(active.cancellation),
        finalize(() => {
          active.inner = undefined;
          if (this.active === active) this.active = undefined;
          active.cancellation.complete();
        }),
      );

      return new Observable<BaseEvent>((subscriber) => {
        let settled = false;
        const subscription = work.subscribe({
          next: (event) => subscriber.next(event),
          error: (error) => {
            settled = true;
            subscriber.error(error);
          },
          complete: () => {
            settled = true;
            subscriber.complete();
          },
        });
        return () => {
          if (!settled) this.cancel(active);
          subscription.unsubscribe();
        };
      });
    });
  }

  clone(): OpenBotChannelAgent {
    const cloned = super.clone() as OpenBotChannelAgent;
    cloned.channelsThreadId = this.channelsThreadId;
    cloned.routing = this.routing;
    cloned.store = this.store;
    cloned.resolver = this.resolver;
    cloned.active = undefined;
    return cloned;
  }

  abortRun(): void {
    const active = this.active;
    if (active) this.cancel(active);
    super.abortRun();
  }

  private cancel(active: ActiveRun): void {
    if (active.cancelled) return;
    active.cancelled = true;
    if (active.started) active.inner?.abortRun();
    active.cancellation.next();
    active.cancellation.complete();
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
