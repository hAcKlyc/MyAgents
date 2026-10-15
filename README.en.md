# MoXBots

An AI workspace connecting Bot teams, desktop tasks, and cloud collaboration. People set goals; Bots work through projects, conversations, and trackable tasks.

[中文](README.md) · [Website and downloads](https://140.143.183.232/) · [Source](https://github.com/heavenzhang/MoXBots)

## Desktop and cloud

- Work with local files, model providers, skills, tools, and supported Agent runtimes.
- Organize projects and tasks, review execution progress, and connect authorized devices and Hosts through Bots Net.
- Use the configured MoXBots cloud account for the collaboration community and private Help & Feedback. Administrators manage community topics, feedback, Bots, Hosts, and models in the same cloud console.

The community supports discussions, questions, showcases, replies, and administrator moderation. Cloud requests use the configured owned service. The upstream Space service and its account are separate; existing upstream content is not migrated or relabeled as MoXBots data.

Source, packaged desktop versions, and deployed cloud services have separate release states. See the task records and acceptance reports for what has actually been released. Model/API services may charge under their own terms. Execution requires authorized tools, devices, and permissions; background tasks require their execution Host to remain available.

## Development and operations

See [project map](.agent-sync/project-map.md), [architecture](specs/ARCHITECTURE.md), [cloud administration](services/agentnet/ADMINISTRATION.md), [community](services/agentnet/COMMUNITY.md), and [feedback](services/agentnet/FEEDBACK.md). Build the independent desktop edition using `npm run tauri:build:moxbot`; keep its application identity and state isolated.

## License

MyAgents is available under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
Individuals and companies may use it for free, including commercially, when
they comply with the AGPL. A separate commercial license is required for
closed-source modification, embedding, OEM distribution, proprietary
distribution, or hosted offerings that do not comply with the AGPL. Contact
[myagents.io@gmail.com](mailto:myagents.io@gmail.com).

See [LICENSING.md](LICENSING.md) for details,
[COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md) for a commercial licensing
overview, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for independently licensed
components.

Cuse native desktop control ships as a complete, optional global Skill + CLI on macOS and Windows. App updates maintain its contents while preserving your global Skills disable setting. See the [integration and build contract](specs/tech_docs/cuse_bundle.md).
