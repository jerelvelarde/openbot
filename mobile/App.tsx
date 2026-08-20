/**
 * The companion, assembled.
 *
 * Navigation is hand-rolled rather than expo-router: there are three tabs and two pushed screens, and
 * a router would be more configuration than the whole app. It stays a real React Native app — the
 * screens use RN primitives only — so the same code runs on a device and in a browser, which is what
 * makes it possible to record the flows without a simulator.
 */
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, useColorScheme, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  type Connection,
  createSource,
  resolveConnection,
} from "./src/data/config";
import { ActivityScreen } from "./src/screens/activity";
import { ApprovalScreen } from "./src/screens/approval";
import { ChannelScreen } from "./src/screens/channel";
import { ChannelsScreen } from "./src/screens/channels";
import { InboxScreen } from "./src/screens/inbox";
import { SourceProvider, useLive } from "./src/store";
import { palettes, space, type as type_ } from "./src/theme";
import { SchemeProvider, useColors } from "./src/ui";

type Route =
  | { name: "inbox" }
  | { name: "channels" }
  | { name: "activity" }
  | { name: "approval"; approvalId: string }
  | { name: "channel"; channelId: string };

const TABS = [
  { name: "inbox" as const, label: "Inbox" },
  { name: "channels" as const, label: "Channels" },
  { name: "activity" as const, label: "Activity" },
];

function TabBar({
  active,
  onSelect,
  waiting,
}: {
  active: Route["name"];
  onSelect: (name: Route["name"]) => void;
  waiting: number;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        borderTopColor: colors.border,
        borderTopWidth: 1,
        backgroundColor: colors.card,
        paddingBottom: Platform.OS === "web" ? space.sm : space.xl,
        paddingTop: space.sm,
      }}
    >
      {TABS.map((tab) => {
        const selected = active === tab.name;
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            onPress={() => onSelect(tab.name)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: space.sm,
              gap: 3,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Text
                style={{
                  ...type_.label,
                  color: selected ? colors.foreground : colors.muted,
                  fontWeight: selected ? "700" : "500",
                }}
              >
                {tab.label}
              </Text>
              {/* The one count worth interrupting somebody for. */}
              {tab.name === "inbox" && waiting > 0 ? (
                <View
                  style={{
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    paddingHorizontal: 5,
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
        paddingVertical: 6,
        backgroundColor: colors.cardMuted,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
      }}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: live ? colors.allow : colors.muted,
        }}
      />
      <Text style={{ ...type_.small, color: colors.muted }}>
        {live ? `Live · ${connection.label}` : "Local · nothing behind it"}
      </Text>
    </View>
  );
}

function Shell({ connection }: { connection: Connection }) {
  const colors = useColors();
  const [route, setRoute] = useState<Route>({ name: "inbox" });
  const [tab, setTab] = useState<Route["name"]>("inbox");
  const approvals = useLive((source) => source.approvals());
  const waiting = (approvals ?? []).filter(
    (one) => one.state === "pending",
  ).length;

  const back = () => setRoute({ name: tab } as Route);
  const openApproval = (approvalId: string) =>
    setRoute({ name: "approval", approvalId });
  const openChannel = (channelId: string) =>
    setRoute({ name: "channel", channelId });

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

  const onTab = (name: Route["name"]) => {
    setTab(name);
    setRoute({ name } as Route);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ConnectionBar connection={connection} />
      <View style={{ flex: 1 }}>{screen}</View>
      <TabBar active={tab} onSelect={onTab} waiting={waiting} />
    </View>
  );
}

export default function App() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
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
   * On a phone the app is the screen. In a browser it is not, and a companion stretched across a
   * desktop window stops being an honest picture of itself — the line lengths, the reach, and the
   * balance between the transcript and the composer are all properties of a narrow screen. So the web
   * build renders inside a device-sized frame, which is also what makes a recording of it legible.
   */
  const framed = Platform.OS === "web";

  const body = (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        overflow: "hidden",
      }}
    >
      <View style={{ height: framed ? 0 : 52 }} />
      <Shell connection={connection} />
    </View>
  );

  return (
    <SchemeProvider value={scheme}>
      <SourceProvider source={source}>
        {framed ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: scheme === "dark" ? "#000000" : "#e4e4e7",
              padding: space.lg,
            }}
          >
            <View
              style={{
                width: 390,
                height: 800,
                maxHeight: "100%",
                borderRadius: 28,
                borderWidth: 1,
                borderColor: colors.border,
                overflow: "hidden",
                backgroundColor: colors.background,
              }}
            >
              {body}
            </View>
          </View>
        ) : (
          body
        )}
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      </SourceProvider>
    </SchemeProvider>
  );
}
