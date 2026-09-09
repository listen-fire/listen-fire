// Connect-action handler registry + the app's shipped handlers.
//
// Importing this module registers every app-shipped handler (each handler
// module self-registers on import). Consumers — the movement editor and the
// chat affordance — import from here so the handlers are wired, then dispatch
// by `kind` through `runConnectAction`.

export {
  runConnectAction,
  hasConnectActionHandler,
  registerConnectActionHandler,
  type ConnectActionContext,
  type ConnectActionHandler,
  type ConnectActionTrpcClient,
} from "./registry";

// Side-effect imports: each handler self-registers its `kind` on load.
import "./google-drive-picker";
import "./connect-credential";
