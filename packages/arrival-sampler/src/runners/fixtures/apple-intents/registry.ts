// registry.ts — the Σ tool surface: a representative slice of Apple's App Intents / SiriKit domains.
//
// This is the device-capability surface a constrained sub-1B model is asked to MATERIALIZE explicit
// intents into. Each tool is a scheme-callable name with arrival-typed params and a one-line doc. The
// set is REPRESENTATIVE (breadth across domains), not exhaustive — ~70 tools spanning the SiriKit /
// App Intents catalog: Messaging, Lists & Notes, Reminders/Calendar, Timers/Alarms/Clock, Calls,
// Maps/Navigation, Music/Media, Camera/Photos, Payments/Wallet, Workouts, Web search, Device settings
// (DND/brightness/flashlight/volume/airplane), Email.
//
// The registry is DATA. sim.ts turns each entry into a recording rosetta binding on the grant
// Environment (the env the oracle masks against, so an UNBOUND tool name is ungeneratable).

/** Arrival-flavoured param types. These are the slot kinds the model fills. `contact`/`enum` are
 *  Σ-over-data shapes (a contact must name a real person in the device's contact list); `string` is
 *  free-text (a message body), scored fuzzily; `number`/`datetime` are literals. */
export type ParamType = "string" | "number" | "datetime" | "contact" | "enum" | "app" | "list" | "boolean";

export interface ToolParam {
  readonly name: string;
  readonly type: ParamType;
  /** For `enum` params: the admissible values (documented to the model in the prompt). */
  readonly values?: readonly string[];
}

export interface ToolSpec {
  readonly name: string;
  readonly domain: string;
  readonly params: readonly ToolParam[];
  readonly doc: string;
}

const p = (name: string, type: ParamType, values?: readonly string[]): ToolParam => ({ name, type, values });

export const APPLE_INTENTS: readonly ToolSpec[] = [
  // ── Messaging ──────────────────────────────────────────────────────────────────────────────────
  {
    name: "send-message",
    domain: "Messaging",
    params: [p("recipient", "contact"), p("body", "string")],
    doc: "Send a text message to a contact.",
  },
  {
    name: "send-group-message",
    domain: "Messaging",
    params: [p("recipients", "list"), p("body", "string")],
    doc: "Send a text message to several contacts.",
  },
  {
    name: "read-messages",
    domain: "Messaging",
    params: [p("from", "contact")],
    doc: "Read the latest messages from a contact.",
  },
  {
    name: "reply-message",
    domain: "Messaging",
    params: [p("body", "string")],
    doc: "Reply to the most recent message.",
  },

  // ── Lists & Notes ──────────────────────────────────────────────────────────────────────────────
  {
    name: "add-to-list",
    domain: "Lists",
    params: [p("list", "string"), p("item", "string")],
    doc: "Add an item to a named list (e.g. a shopping list).",
  },
  {
    name: "remove-from-list",
    domain: "Lists",
    params: [p("list", "string"), p("item", "string")],
    doc: "Remove an item from a named list.",
  },
  { name: "show-list", domain: "Lists", params: [p("list", "string")], doc: "Show the contents of a named list." },
  {
    name: "create-note",
    domain: "Notes",
    params: [p("title", "string"), p("body", "string")],
    doc: "Create a note with a title and body.",
  },
  {
    name: "append-to-note",
    domain: "Notes",
    params: [p("title", "string"), p("text", "string")],
    doc: "Append text to an existing note.",
  },

  // ── Reminders / Calendar ───────────────────────────────────────────────────────────────────────
  {
    name: "create-reminder",
    domain: "Reminders",
    params: [p("text", "string"), p("due", "datetime")],
    doc: "Create a reminder with text and an optional due date/time.",
  },
  {
    name: "complete-reminder",
    domain: "Reminders",
    params: [p("text", "string")],
    doc: "Mark a reminder as completed.",
  },
  { name: "list-reminders", domain: "Reminders", params: [], doc: "List the open reminders." },
  {
    name: "create-event",
    domain: "Calendar",
    params: [p("title", "string"), p("start", "datetime"), p("end", "datetime")],
    doc: "Create a calendar event.",
  },
  { name: "next-event", domain: "Calendar", params: [], doc: "Show the next calendar event." },

  // ── Timers / Alarms / Clock ────────────────────────────────────────────────────────────────────
  {
    name: "set-timer",
    domain: "Clock",
    params: [p("seconds", "number")],
    doc: "Start a countdown timer for a number of SECONDS.",
  },
  { name: "cancel-timer", domain: "Clock", params: [], doc: "Cancel the running timer." },
  { name: "set-alarm", domain: "Clock", params: [p("time", "datetime")], doc: "Set an alarm for a clock time." },
  { name: "delete-alarm", domain: "Clock", params: [p("time", "datetime")], doc: "Delete an alarm at a clock time." },
  { name: "world-clock", domain: "Clock", params: [p("city", "string")], doc: "Show the time in a city." },
  { name: "start-stopwatch", domain: "Clock", params: [], doc: "Start the stopwatch." },

  // ── Calls ──────────────────────────────────────────────────────────────────────────────────────
  {
    name: "call-contact",
    domain: "Calls",
    params: [p("recipient", "contact")],
    doc: "Place a phone call to a contact.",
  },
  {
    name: "facetime-contact",
    domain: "Calls",
    params: [p("recipient", "contact")],
    doc: "Start a FaceTime call with a contact.",
  },
  { name: "redial", domain: "Calls", params: [], doc: "Call the last dialed number." },

  // ── Maps / Navigation ──────────────────────────────────────────────────────────────────────────
  {
    name: "navigate-to",
    domain: "Maps",
    params: [p("destination", "string")],
    doc: "Start turn-by-turn navigation to a place.",
  },
  { name: "navigate-home", domain: "Maps", params: [], doc: "Start navigation to the user's home address." },
  { name: "navigate-work", domain: "Maps", params: [], doc: "Start navigation to the user's work address." },
  {
    name: "find-nearby",
    domain: "Maps",
    params: [p("category", "string")],
    doc: "Find nearby places of a category (e.g. coffee, gas).",
  },
  { name: "show-eta", domain: "Maps", params: [p("destination", "string")], doc: "Show the ETA to a destination." },

  // ── Music / Media ──────────────────────────────────────────────────────────────────────────────
  { name: "play-music", domain: "Music", params: [], doc: "Play music (resume or shuffle the library)." },
  { name: "play-song", domain: "Music", params: [p("song", "string")], doc: "Play a specific song by name." },
  { name: "play-artist", domain: "Music", params: [p("artist", "string")], doc: "Play music by an artist." },
  { name: "play-playlist", domain: "Music", params: [p("playlist", "string")], doc: "Play a named playlist." },
  { name: "pause-music", domain: "Music", params: [], doc: "Pause playback." },
  { name: "next-track", domain: "Music", params: [], doc: "Skip to the next track." },
  { name: "previous-track", domain: "Music", params: [], doc: "Go to the previous track." },
  { name: "set-volume", domain: "Music", params: [p("level", "number")], doc: "Set the media volume (0-100)." },

  // ── Camera / Photos ────────────────────────────────────────────────────────────────────────────
  { name: "take-photo", domain: "Camera", params: [], doc: "Take a photo with the rear camera." },
  { name: "take-selfie", domain: "Camera", params: [], doc: "Take a photo with the front camera." },
  { name: "record-video", domain: "Camera", params: [], doc: "Start recording a video." },
  { name: "open-camera", domain: "Camera", params: [], doc: "Open the camera app." },
  { name: "search-photos", domain: "Photos", params: [p("query", "string")], doc: "Search the photo library." },

  // ── Payments / Wallet ──────────────────────────────────────────────────────────────────────────
  {
    name: "send-payment",
    domain: "Payments",
    params: [p("recipient", "contact"), p("amount", "number")],
    doc: "Send a payment of an amount to a contact.",
  },
  {
    name: "request-payment",
    domain: "Payments",
    params: [p("from", "contact"), p("amount", "number")],
    doc: "Request a payment of an amount from a contact.",
  },
  { name: "show-balance", domain: "Wallet", params: [], doc: "Show the wallet balance." },
  { name: "show-boarding-pass", domain: "Wallet", params: [], doc: "Show the boarding pass." },

  // ── Workouts ───────────────────────────────────────────────────────────────────────────────────
  {
    name: "start-workout",
    domain: "Workouts",
    params: [p("kind", "enum", ["run", "walk", "cycle", "swim", "yoga", "strength"])],
    doc: "Start a workout of a kind.",
  },
  { name: "pause-workout", domain: "Workouts", params: [], doc: "Pause the active workout." },
  { name: "end-workout", domain: "Workouts", params: [], doc: "End the active workout." },
  { name: "show-activity", domain: "Workouts", params: [], doc: "Show today's activity rings." },

  // ── Web search ─────────────────────────────────────────────────────────────────────────────────
  { name: "web-search", domain: "Web", params: [p("query", "string")], doc: "Search the web for a query." },
  { name: "open-website", domain: "Web", params: [p("url", "string")], doc: "Open a website URL." },
  { name: "wiki-lookup", domain: "Web", params: [p("topic", "string")], doc: "Look up a topic on Wikipedia." },

  // ── Device settings ────────────────────────────────────────────────────────────────────────────
  {
    name: "set-do-not-disturb",
    domain: "Settings",
    params: [p("on", "boolean")],
    doc: "Turn Do Not Disturb on or off.",
  },
  { name: "set-brightness", domain: "Settings", params: [p("level", "number")], doc: "Set screen brightness (0-100)." },
  { name: "set-flashlight", domain: "Settings", params: [p("on", "boolean")], doc: "Turn the flashlight on or off." },
  { name: "set-airplane-mode", domain: "Settings", params: [p("on", "boolean")], doc: "Turn airplane mode on or off." },
  { name: "set-wifi", domain: "Settings", params: [p("on", "boolean")], doc: "Turn Wi-Fi on or off." },
  { name: "set-bluetooth", domain: "Settings", params: [p("on", "boolean")], doc: "Turn Bluetooth on or off." },
  { name: "set-low-power", domain: "Settings", params: [p("on", "boolean")], doc: "Turn Low Power Mode on or off." },
  {
    name: "set-system-volume",
    domain: "Settings",
    params: [p("level", "number")],
    doc: "Set the system volume (0-100).",
  },
  { name: "lock-screen", domain: "Settings", params: [], doc: "Lock the device screen." },
  { name: "open-app", domain: "Settings", params: [p("app", "app")], doc: "Open an installed app by name." },

  // ── Email ──────────────────────────────────────────────────────────────────────────────────────
  {
    name: "send-email",
    domain: "Email",
    params: [p("to", "contact"), p("subject", "string"), p("body", "string")],
    doc: "Send an email to a contact.",
  },
  { name: "read-email", domain: "Email", params: [], doc: "Read the latest unread email." },
  { name: "search-email", domain: "Email", params: [p("query", "string")], doc: "Search the mailbox." },

  // ── Weather (a couple cross-domain extras for breadth) ───────────────────────────────────────────
  { name: "weather-now", domain: "Weather", params: [], doc: "Show the current weather." },
  { name: "weather-forecast", domain: "Weather", params: [p("day", "string")], doc: "Show the forecast for a day." },
  {
    name: "translate-text",
    domain: "Translate",
    params: [p("text", "string"), p("language", "string")],
    doc: "Translate text into a language.",
  },
];

/** Tool lookup by name (for tasks / scorers that need the spec). */
export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(APPLE_INTENTS.map((t) => [t.name, t]));
