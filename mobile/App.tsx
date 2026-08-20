/**
 * The companion, assembled.
 *
 * Navigation is hand-rolled rather than expo-router: there are three tabs and two pushed screens, and
 * a router would be more configuration than the whole app. It stays a real React Native app — the
 * screens use RN primitives only — so the same code runs on a device and in a browser, which is what
 * makes it possible to record the flows without a simulator.
 */

import * as Notifications from "expo-notifications";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  type Connection,
  createSource,
  resolveConnection,
} from "./src/data/config";
import { targetOf } from "./src/data/push";
import { SessionProvider, useSession } from "./src/data/session";
import {
  DeviceFrame,
  HomeIndicator,
  SCREEN_HEIGHT,
  StatusBar,
} from "./src/device";
import { ActivityScreen } from "./src/screens/activity";
import { ApprovalScreen } from "./src/screens/approval";
import { ChannelScreen } from "./src/screens/channel";
import { ChannelsScreen } from "./src/screens/channels";
import { InboxScreen } from "./src/screens/inbox";
import { SignInScreen } from "./src/screens/sign-in";
import { SourceProvider, useLive } from "./src/store";
import { palettes, space, type as type_ } from "./src/theme";
import { SchemeProvider, useColors } from "./src/ui";

/** The three tabs. A route is one of these, or one of the two screens pushed over them. */
type TabName = "inbox" | "channels" | "activity";

type Route =
  | { name: TabName }
  | { name: "approval"; approvalId: string }
  | { name: "channel"; channelId: string };

/**
 * The tab icons, drawn from Views.
 *
 * No icon font and no SVG dependency: three shapes are cheaper than either, and a font that fails to
 * load leaves a row of empty boxes where the navigation used to be.
 */
function TabIcon({ name, color }: { name: TabName; color: string }) {
  if (name === "inbox") {
    // A tray: a line with two shoulders.
    return (
      <View style={{ width: 20, height: 20, justifyContent: "center" }}>
        <View
          style={{
            height: 9,
            borderLeftWidth: 2,
            borderRightWidth: 2,
            borderBottomWidth: 2,
            borderColor: color,
            borderBottomLeftRadius: 4,
            borderBottomRightRadius: 4,
          }}
        />
        <View
          style={{
            position: "absolute",
            top: 3,
            left: 5,
            width: 10,
            height: 2,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      </View>
    );
  }
  if (name === "channels") {
    // Two overlapping bubbles.
    return (
      <View style={{ width: 20, height: 20 }}>
        <View
          style={{
            position: "absolute",
            top: 2,
            left: 0,
            width: 13,
            height: 11,
            borderWidth: 2,
            borderColor: color,
            borderRadius: 4,
          }}
        />
        <View
          style={{
            position: "absolute",
            bottom: 1,
            right: 0,
            width: 13,
            height: 11,
            borderWidth: 2,
            borderColor: color,
            borderRadius: 4,
          }}
        />
      </View>
    );
  }
  // Three stacked lines of decreasing length: a list of what happened.
  return (
    <View style={{ width: 20, height: 20, justifyContent: "center", gap: 3 }}>
      {[16, 12, 8].map((width) => (
        <View
          key={width}
          style={{
            width,
            height: 2,
            borderRadius: 1,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

const TABS: { name: TabName; label: string }[] = [
  { name: "inbox", label: "Inbox" },
  { name: "channels", label: "Channels" },
  { name: "activity", label: "Activity" },
];

function TabBar({
  active,
  onSelect,
  waiting,
  framed,
}: {
  active: TabName;
  onSelect: (name: TabName) => void;
  waiting: number;
  framed: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        borderTopColor: colors.border,
        borderTopWidth: 1,
        backgroundColor: colors.card,
        paddingTop: space.sm,
        // In the frame the home indicator supplies the bottom inset; on a device the safe area does.
        paddingBottom: framed ? space.xs : space.xl,
      }}
    >
      {TABS.map((tab) => {
        const selected = active === tab.name;
        const tint = selected ? colors.foreground : colors.muted;
        return (
          <Pressable
            accessibilityRole="tab"
            key={tab.name}
            onPress={() => onSelect(tab.name)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 6,
              gap: 4,
            }}
          >
            <View>
              <TabIcon color={tint} name={tab.name} />
              {/* The one count worth interrupting somebody for. */}
              {tab.name === "inbox" && waiting > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -8,
                    minWidth: 17,
                    height: 17,
                    borderRadius: 9,
                    paddingHorizontal: 4.5,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.pending,
                  }}
                >
                  <Text
                    style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}
                  >
                    {waiting}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{
                ...type_.small,
                fontSize: 11,
                color: tint,
                fontWeight: selected ? "700" : "500",
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Which deployment is on screen.
 *
 * Shown, not hidden, and shown in every build. "Is this real?" is the first question anybody asks of
 * a screenshot of an approval, and a companion that cannot answer it is one nobody should trust.
 */
function ConnectionBar({ connection }: { connection: Connection }) {
  const colors = useColors();
  const live = connection.kind === "live";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: space.lg,
        paddingVertical: 5,
        backgroundColor: colors.cardMuted,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: live ? colors.allow : colors.muted,
        }}
      />
      <Text style={{ ...type_.small, fontSize: 11, color: colors.muted }}>
        {live ? `Live · ${connection.label}` : "Local · nothing behind it"}
      </Text>
    </View>
  );
}

function Shell({
  connection,
  framed,
}: {
  connection: Connection;
  framed: boolean;
}) {
  const colors = useColors();
  const [route, setRoute] = useState<Route>({ name: "inbox" });
  const [tab, setTab] = useState<TabName>("inbox");
  const approvals = useLive((source) => source.approvals());
  const waiting = (approvals ?? []).filter(
    (one) => one.state === "pending",
  ).length;

  const back = () => setRoute({ name: tab });
  const openApproval = useCallback(
    (approvalId: string) => setRoute({ name: "approval", approvalId }),
    [],
  );
  const openChannel = useCallback(
    (channelId: string) => setRoute({ name: "channel", channelId }),
    [],
  );

  /**
   * Opening the app from a notification lands on the thing it was about.
   *
   * A push that drops somebody on a list they then have to search is a push that wasted the
   * interruption it cost.
   */
  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const target = targetOf(
          response.notification.request.content.data as unknown,
        );
        if (target.screen === "approval") openApproval(target.approvalId);
        else if (target.screen === "channel") openChannel(target.channelId);
        else {
          setTab("inbox");
          setRoute({ name: "inbox" });
        }
      },
    );
    return () => subscription.remove();
  }, [openApproval, openChannel]);

  const screen = (() => {
    switch (route.name) {
      case "approval":
        return <ApprovalScreen approvalId={route.approvalId} onBack={back} />;
      case "channel":
        return (
          <ChannelScreen
            channelId={route.channelId}
            onBack={back}
            onOpenApproval={openApproval}
          />
        );
      case "channels":
        return <ChannelsScreen onOpenChannel={openChannel} />;
      case "activity":
        return <ActivityScreen />;
      default:
        return (
          <InboxScreen
            onOpenApproval={openApproval}
            onOpenChannel={openChannel}
          />
        );
    }
  })();

  const onTab = (name: TabName) => {
    setTab(name);
    setRoute({ name });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ConnectionBar connection={connection} />
      <View style={{ flex: 1 }}>{screen}</View>
      <TabBar active={tab} framed={framed} onSelect={onTab} waiting={waiting} />
    </View>
  );
}

/**
 * Signed in, or the screen that asks.
 *
 * Inside the provider rather than around it, because whether a sign-in is even needed is a property of
 * the connection: same-origin in a browser already has a cookie, and a local build has no deployment
 * to sign in to.
 */
function Gate({
  connection,
  framed,
}: {
  connection: Connection;
  framed: boolean;
}) {
  const { state } = useSession();

  if (state.status === "unknown") {
    // Blank rather than a spinner: this resolves in a few milliseconds from the secure store, and a
    // spinner that flashes is worse than nothing.
    return <View style={{ flex: 1 }} />;
  }
  if (state.status === "signed-in") {
    return <Shell connection={connection} framed={framed} />;
  }
  return (
    <SignInScreen
      label={
        connection.kind === "live"
          ? connection.label
          : "No deployment configured."
      }
    />
  );
}

export default function App() {
  const scheme = "light";
  /**
   * One source for the life of the app.
   *
   * Rebuilding it would restart the deployment it represents, and against a live server it would
   * throw away the poll subscription mid-flight.
   */
  const connection = useMemo(() => resolveConnection(), []);
  const source = useMemo(() => createSource(connection), [connection]);
  const colors = palettes[scheme];

  /**
   * On a phone the app is the screen. In a browser it is not, so the web build draws a phone around
   * itself at a real phone's proportions. See `src/device.tsx`.
   */
  const framed = Platform.OS === "web";

  const body = (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {framed ? (
        <StatusBar background={colors.card} color={colors.foreground} />
      ) : (
        <View style={{ height: 52, backgroundColor: colors.card }} />
      )}
      <Gate connection={connection} framed={framed} />
      {framed ? <HomeIndicator color={colors.foreground} /> : null}
    </View>
  );

  return (
    <SchemeProvider value={scheme}>
      <SessionProvider
        baseUrl={connection.kind === "live" ? connection.baseUrl : ""}
      >
        <SourceProvider source={source}>
          {framed ? (
            <DeviceFrame backdrop="#e7e7ea">
              <View style={{ height: SCREEN_HEIGHT }}>{body}</View>
            </DeviceFrame>
          ) : (
            body
          )}
          <ExpoStatusBar style="dark" />
        </SourceProvider>
      </SessionProvider>
    </SchemeProvider>
  );
}
