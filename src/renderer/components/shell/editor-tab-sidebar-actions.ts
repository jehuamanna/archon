import {
  dispatchIdeShellAction,
  type IdeShellAction,
  type IdeShellActionPayload,
} from "../../plugin-ide/ideShellBridge";

export function fireIdeShellAction(
  type: IdeShellAction,
  payload?: IdeShellActionPayload,
): void {
  dispatchIdeShellAction(type, payload);
}
