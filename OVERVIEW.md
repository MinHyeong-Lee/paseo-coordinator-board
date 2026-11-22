# Session coordinator board

The board groups existing Paseo sessions by project and shows which decisions need your attention. A coordinator can review recent conversations, assign work on this host, and report back. The interface supports Korean and English. Open **설정 → 보드 언어 → English** to switch this device to English.

## Install and choose projects

On the computer running Paseo 0.16.2 or later, enable trusted plugins and install the GitHub source directly.

```sh
paseo plugin install git:devbrother2024/paseo-coordinator-board
```

The `git:` prefix selects a Git source. Paseo uses the plain `owner/slug` form for registry entries. For a ZIP installation, unzip the package and run `paseo plugin install .` in the folder containing `paseo-plugin.json`. Keep that folder in place. [Source](https://github.com/devbrother2024/paseo-coordinator-board) · [Paseo plugin guide](https://paseo.sh/docs/plugins)

Open the board from the sidebar and select the projects you want in your digest. To manage just one session from another project, open **Settings → Link an existing session to a project**. Search for the session, check its ID and source workspace, select a managed destination, then click **Link to this project**. The card appears once under its destination. The session keeps its original ID, workspace, files and conversation. **Unlink from project** removes the link. The card returns to its source project if that project is also managed.

## Work with a coordinator

Click **Start with recommended settings** to create the coordinator, or select **Choose an existing coordinator session** in Settings. Before creating or replacing a coordinator, the board shows the model and tool permission mode. It prefers Auto mode for Claude Code and Auto-review for Codex when supported. OpenCode with Build mode and Copilot with Agent mode can serve as alternatives when their coordinator mode is available on the host. For other providers, you can designate an existing session with Paseo MCP.

Paseo pins a new coordinator workspace in the host’s sidebar by default. Turn this off in **Settings → Sidebar pinning**. Replacing the coordinator in the same workspace preserves its existing pin state. For an existing coordinator, click **Pin current coordinator workspace**.

Use **Send to coordinator** to delegate work. **Request digest** asks the designated session to inspect the latest excerpts and record which decisions need a person. The board displays that evidence and refreshes while open. A new message can invalidate the coordinator's earlier judgment.

Each session decision has an **Open assigned session** button beside the project and session name. It opens the original conversation without sending a reply. The card leads with the question and one suggested reply. Open **View source** for the original text and the reason behind the suggestion. Use **Ask coordinator for a recommendation** to revisit an older card. If a necessary detail is missing, the card asks for that detail. Other actions sit under **Other actions**.

A worker asking “Which project does this session belong to?” can receive a verified answer from the designated coordinator during a requested digest. The project card shows a record of the response. **Settings → Automatic replies to factual questions** lets you turn this off for the host. Receiving a reply can start the worker's model and use its provider allowance. A decision such as deleting a work folder still requires the person responsible.

- **Reply to a session.** Review the recipient and use **Send suggested reply** or choose an option and use **Send selected reply**. **Edit reply** and **Write a reply** let you send your own wording.
- **Ask for clarification.** Use **Ask a question** to send a question to the assigned session. To coordinate across tasks, choose **Ask coordinator to coordinate**, review the recipient, then use **Send request to coordinator**.
- **Respond to a native approval.** Choose **Open assigned session** to open Paseo's permission or plan dialog. A delivery receipt confirms that the session received your message. Verify the result before recording completion.

## GitHub pull requests

The sidebar count combines sessions awaiting a person and pull requests ready for a merge decision. A pull request shared by several managed projects counts once. Open it on GitHub to review or merge. Drafts and pull requests waiting for checks appear in project progress. The board reads open pull requests with the host’s authenticated GitHub CLI. In **Settings → GitHub repositories by project**, choose automatic detection, enter an explicit repository, or turn off lookup for a project.

## Models, hosts and tools

In **Settings**, choose providers and models for task grades A through D, or the M grade used to create or replace the coordinator. Providers discovered on the active host are included by default. You can exclude a provider and restore it later. The model selector shows eligible providers, available models, and reasons a saved model cannot be used. The current route appears first and preselects its model and effort. With only Codex, grades use the connected Codex models. Without an available Claude Code or Codex model, ordinary higher-grade tasks can use another connected provider. If a saved list has no available candidate, edit it or choose **Restore defaults**. Session cards show the provider and model reported by Paseo. Under **Settings → Paseo hosts**, each device shows its connection and whether its sessions appear in the list. Use **Hide** or **Show** to change visibility. New work is assigned on the board's current host.

The coordinator uses `read_board_conversation` to read managed sessions and `classify_board_conversation` to record a judgment tied to the current evidence. It uses `plan_board_assignment` and `assign_board_worker` to delegate work. A worker with reporting enabled can post a question or a result to its own card with `report_to_board`. These tools require Paseo MCP integration in the session's provider.

The host stores project selections, session links, judgments, delivery receipts and notes in its local plugin data. Opening the board does not start a model. When you send a message, the receiving session uses its provider under your existing plan. [한국어 사용 안내](README.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
