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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  Text,
  useColorScheme,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
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
import { SourceProvider, useLiveResult } from "./src/store";
import { type Scheme, space, type as type_ } from "./src/theme";
import { SchemeProvider, useColors } from "./src/ui";

/**
 * What a notification does when it lands while the app is open.
 *
 * The documented default is to show nothing at all, which for this app means a Bot parked on an
 * approval interrupts nobody precisely when somebody is holding the phone. `shouldShowAlert` is the
 * deprecated spelling; banner and list are what this version reads.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

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
  /** Undefined means nobody has answered yet, which is not the same as none. */
  waiting: number | undefined;
  framed: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        borderTopColor: colors.border,
        borderTopWidth: 1,
        backgroundColor: colors.card,
        paddingTop: space.sm,
        /**
         * In the frame the drawn home indicator supplies the bottom inset; on a device the real one
         * does. This was a hardcoded 24, which is less than an Android three-button navigation bar —
         * so the labels were drawn beneath it and taps in that band went to the system.
         */
        paddingBottom: framed ? space.xs : Math.max(insets.bottom, space.sm),
      }}
    >
      {TABS.map((tab) => {
        const selected = active === tab.name;
        const tint = selected ? colors.foreground : colors.muted;
        const count = tab.name === "inbox" ? waiting : undefined;
        return (
          <Pressable
            accessibilityLabel={
              count ? `${tab.label}, ${count} waiting on you` : tab.label
            }
            accessibilityRole="tab"
            // react-native-web 0.21 does not map accessibilityState, so the ARIA prop is what
            // actually reaches the DOM. Both are declared, so both targets announce the selection.
            accessibilityState={{ selected }}
            android_ripple={{ color: colors.border, borderless: true }}
            aria-selected={selected}
            key={tab.name}
            onPress={() => onSelect(tab.name)}
            style={({ pressed }) => ({
              flex: 1,
              alignItems: "center",
              paddingVertical: 6,
              gap: 4,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View importantForAccessibility="no-hide-descendants">
              <TabIcon color={tint} name={tab.name} />
              {/* The one count worth interrupting somebody for — and, when the deployment has not
                  answered yet, an empty ring rather than a confident zero. */}
              {count === undefined && tab.name === "inbox" ? (
                <View
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -8,
                    width: 17,
                    height: 17,
                    borderRadius: 9,
                    borderWidth: 2,
                    borderColor: colors.muted,
                    opacity: 0.6,
                  }}
                />
              ) : null}
              {count ? (
                <View
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -8,
                    minWidth: 17,
                    minHeight: 17,
                    borderRadius: 999,
                    paddingHorizontal: 4.5,
                    paddingVertical: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.pending,
                  }}
                >
                  <Text
                    maxFontSizeMultiplier={1.6}
                    style={{
                      fontSize: 11,
                      fontWeight: "700",
                      color: colors.accentForeground,
                    }}
                  >
                    {count}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              maxFontSizeMultiplier={1.6}
              numberOfLines={1}
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
 * Which deployment is on screen, and whether it is answering.
 *
 * Shown, not hidden, and shown in every build. "Is this real?" is the first question anybody asks of
 * a screenshot of an approval, and a companion that cannot answer it is one nobody should trust.
 *
 * `reachable` matters as much as `live`: the label comes from build configuration, so during an
 * outage this said "Live" in the colour that means permitted, directly above a screen saying it could
 * not reach the deployment — and on Channels and Activity it is the only status signal there is.
 */
function ConnectionBar({
  connection,
  reachable,
}: {
  connection: Connection;
  reachable: boolean;
}) {
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
          backgroundColor: !live
            ? colors.muted
            : reachable
              ? colors.allow
              : colors.fail,
        }}
      />
      <Text style={{ ...type_.small, fontSize: 11, color: colors.muted }}>
        {live
          ? `Live · ${connection.label}${reachable ? "" : " · not answering"}`
          : "Local · nothing behind it"}
      </Text>
    </View>
  );
}

/**
 * Opening the app from a notification lands on the thing it was about.
 *
 * `useLastNotificationResponse` rather than a listener: a listener registered in the shell only
 * exists once the session has been read out of the secure store, by which time a cold start's
 * response has already been delivered and dropped — so the push that woke somebody put them on the
 * Inbox with nothing said. A push that drops a person on a list they then have to search is a push
 * that wasted the interruption it cost.
 *
 * Its own component because the hook reaches a native method that does not exist on web, and throwing
 * from a layout effect there takes the whole app down with it. Rendering it conditionally is the only
 * way to not call a hook.
 */
function PushRouting({
  onOpenApproval,
  onOpenChannel,
  onTab,
  setTab,
}: {
  onOpenApproval: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onTab: (name: TabName) => void;
  setTab: (name: TabName) => void;
}) {
  const response = Notifications.useLastNotificationResponse();
  const routed = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!response) return;
    // Delivered once. The hook keeps handing back the same response, including the one that was
    // already acted on when the app started.
    const id = response.notification.request.identifier;
    if (routed.current === id) return;
    routed.current = id;

    const target = targetOf(response.notification.request.content.data);
    if (target.screen === "approval") {
      setTab("inbox");
      onOpenApproval(target.approvalId);
    } else if (target.screen === "channel") {
      setTab("channels");
      onOpenChannel(target.channelId);
    } else {
      onTab("inbox");
    }
  }, [onOpenApproval, onOpenChannel, onTab, setTab, response]);

  return null;
}

function Shell({
  connection,
  framed,
}: {
  connection: Connection;
  framed: boolean;
}) {
  const colors = useColors();
  /**
   * A stack, not a current route.
   *
   * Back used to mean "go to the tab I was on", so an approval opened from inside a conversation
   * returned to the channel list rather than to the conversation. A stack is also what the Android
   * back button needs to be able to pop.
   */
  const [stack, setStack] = useState<Route[]>([{ name: "inbox" }]);
  const [tab, setTab] = useState<TabName>("inbox");
  const { value: approvals, error } = useLiveResult((source) =>
    source.approvals(),
  );
  const waiting = approvals?.filter((one) => one.state === "pending").length;

  const pop = useCallback(() => {
    setStack((current) =>
      current.length > 1 ? current.slice(0, -1) : current,
    );
  }, []);
  const openApproval = useCallback((approvalId: string) => {
    setStack((current) => [...current, { name: "approval", approvalId }]);
  }, []);
  const openChannel = useCallback((channelId: string) => {
    setStack((current) => [...current, { name: "channel", channelId }]);
  }, []);
  const onTab = useCallback((name: TabName) => {
    setTab(name);
    setStack([{ name }]);
  }, []);

  /**
   * The Android back button, which otherwise quits the app from a pushed screen.
   *
   * Returning false at the root is the convention — back should still leave the app — and the
   * platform guard matters because react-native-web's BackHandler logs an error to a console that
   * belongs to the recorded build.
   */
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (stack.length > 1) {
          pop();
          return true;
        }
        if (tab !== "inbox") {
          onTab("inbox");
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [onTab, pop, stack.length, tab]);

  const route = stack[stack.length - 1] ?? { name: tab };
  const screen = (() => {
    switch (route.name) {
      case "approval":
        return (
          <ApprovalScreen
            approvalId={route.approvalId}
            onBack={pop}
            onOpenChannel={openChannel}
          />
        );
      case "channel":
        return (
          <ChannelScreen
            channelId={route.channelId}
            onBack={pop}
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Mounted only where the hook inside it can run. Conditional on a module constant, so the
          tree shape never changes at runtime and no hook order is disturbed. */}
      {Platform.OS === "web" ? null : (
        <PushRouting
          onOpenApproval={openApproval}
          onOpenChannel={openChannel}
          onTab={onTab}
          setTab={setTab}
        />
      )}
      <ConnectionBar connection={connection} reachable={!error} />
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
  const colors = useColors();
  const { state } = useSession();

  if (state.status === "unknown") {
    // Blank rather than a spinner: this resolves in a few milliseconds from the secure store, and a
    // spinner that flashes is worse than nothing. Painted, so it is not a hole in the app.
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }
  if (state.status === "signed-in") {
    return <Shell connection={connection} framed={framed} />;
  }
  return (
    <SignInScreen
      label={connection.kind === "live" ? connection.label : "this deployment"}
    />
  );
}

/** Inside the scheme provider, so there is one path to the palette. */
function Chrome({
  connection,
  framed,
  scheme,
}: {
  connection: Connection;
  framed: boolean;
  scheme: Scheme;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {framed ? (
        <StatusBar background={colors.card} color={colors.foreground} />
      ) : (
        // The real inset, not a guess: 52 is wrong on every iPhone (20 / 47 / 59) and on Android.
        <View style={{ height: insets.top, backgroundColor: colors.card }} />
      )}
      <Gate connection={connection} framed={framed} />
      {framed ? <HomeIndicator color={colors.foreground} /> : null}
      <ExpoStatusBar style={scheme === "dark" ? "light" : "dark"} />
    </View>
  );
}

export default function App() {
  /**
   * The phone's own appearance setting, on a phone.
   *
   * `app.json` has declared `userInterfaceStyle: "automatic"` all along and `ui.tsx` says the app
   * follows the phone — while this was pinned to light, so a dark-mode phone got a full-brightness
   * white app wearing a dark system keyboard. The web build stays pinned, because it is a phone
   * mockup for recordings and every published artefact should keep looking like the last one.
   */
  const system = useColorScheme();
  /**
   * On a phone the app is the screen. In a browser it is not, so the web build draws a phone around
   * itself at a real phone's proportions. See `src/device.tsx`.
   */
  const framed = Platform.OS === "web";
  // `useColorScheme` can also report "unspecified", which is a phone with no preference: light.
  const scheme: Scheme = framed || system !== "dark" ? "light" : "dark";

  /**
   * One source for the life of the app.
   *
   * Rebuilding it would restart the deployment it represents, and against a live server it would
   * throw away the poll subscription mid-flight.
   */
  const connection = useMemo(() => resolveConnection(), []);
  const source = useMemo(() => createSource(connection), [connection]);

  /**
   * Where an approval notification is loud enough to be seen.
   *
   * Android drops anything without a channel into the default one, whose importance the system may
   * have set to "silent" — which for this app means the interruption the whole product is built
   * around arrives without a sound or a banner.
   */
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void Notifications.setNotificationChannelAsync("approvals", {
      name: "Approvals",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }, []);

  return (
    <SafeAreaProvider>
      <SchemeProvider value={scheme}>
        <SessionProvider
          baseUrl={connection.kind === "live" ? connection.baseUrl : ""}
        >
          <SourceProvider source={source}>
            {framed ? (
              <DeviceFrame backdrop="#e7e7ea">
                <View style={{ height: SCREEN_HEIGHT }}>
                  <Chrome
                    connection={connection}
                    framed={framed}
                    scheme={scheme}
                  />
                </View>
              </DeviceFrame>
            ) : (
              <Chrome connection={connection} framed={framed} scheme={scheme} />
            )}
          </SourceProvider>
        </SessionProvider>
      </SchemeProvider>
    </SafeAreaProvider>
  );
}
