Coordinator Board groups existing Paseo sessions by project and shows which ones are waiting for a person. Open the board on a connected host to see its sessions. A card opens the original conversation. The interface is in Korean.

Paseo supplies the workspace, model when available, and lifecycle signals. A permission request appears in the decision digest. An unread result or an error goes to review. A session can be idle while the work still needs verification. Record a question, a result to check, or evidence of completion on its card. The board refreshes while open.

Optionally enable reporting on a session's card. With Paseo MCP enabled and injected into the provider, on its next interactive session open the agent receives a tool to post a question or a result for review on that session's own card. People retain control of approvals and verified completion. The package includes a short Korean template for choosing which decisions you want to handle.

The plugin targets Paseo 0.16.2 and later. Install it on the Paseo host where you coordinate your projects. It uses the host's session and workspace directory and keeps board notes in the daemon's local plugin data. The reporting switch is stored in the selected session's metadata. Using a model in that session is subject to your provider's normal terms.

Select the projects to manage on first use. The board reads bounded conversation excerpts on that host and surfaces ordinary confirmation requests. A designated coordinator can read recent user and assistant turns for selected projects and record a judgment tied to that excerpt. Later messages invalidate that judgment. Reviewing the board does not start a model.

Submit a task in your own words. The coordinator starts with recommended models available on this host. Open Settings to change the preferred and fallback models for a task grade or to replace the coordinator. The coordinator selects a managed workspace and worker model on this host. Replacing the coordinator preserves board judgments. Review the included TypeScript source to adapt the charter, default policy, and task assignment to your workflow.

Provider settings discover the runners and selectable models exposed by the active Paseo host, including custom ACP providers. Each runner shows its registered ID, catalog status and eligible task grades. Newly discovered runners are included by default. You can exclude one from future assignments or restore it while keeping your model preferences. Session cards show the runner and model reported by Paseo.

A new or replacement coordinator previews its tool permission mode. Claude Code uses Auto mode where available. Codex uses Auto-review where available. Older providers fall back to interactive approvals. Digest requests keep the current session and its permissions.
