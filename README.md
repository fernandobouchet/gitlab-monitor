# GitLab Monitor

Read-only GNOME Shell extension for monitoring activity, merge requests, and pipelines across selected GitLab projects.

The MVP scope and design decisions are documented in [MVP.md](MVP.md).

## Status

Initial MVP implemented for GNOME Shell 50:

- Authentication reused from GitLab CLI (`glab`).
- Selection of up to ten projects.
- Recent activity, open merge requests, and latest pipeline.
- Manual refresh and configurable polling.
- Optional notifications for pipelines, new merge requests, and pushes to the default branch.
- Links to open each resource in GitLab.
- GitLab access restricted to an allowlist of `GET` requests.

## Requirements

- GNOME Shell 50.
- GitLab CLI (`glab`).
- A `glab` session for GitLab.com or GitLab Self-Managed.

The extension does not install dependencies or manage credentials.

## Authentication

Authenticate from a terminal:

```bash
glab auth login --hostname gitlab.com --web --use-keyring
```

For GitLab Self-Managed, replace `gitlab.com` with the appropriate hostname.

## Local installation

From the project root:

```bash
gnome-extensions pack \
  --force \
  --extra-source=glab-client.js \
  --extra-source=notifications.js \
  --extra-source=project-monitor.js \
  --extra-source=state-store.js \
  --extra-source=gitlab-symbolic.svg \
  --schema=schemas/org.gnome.shell.extensions.gitlab-monitor.gschema.xml \
  .
```

Install the generated ZIP:

```bash
gnome-extensions install --force gitlab-monitor@fernandobouchet.shell-extension.zip
```

Log out and back in, or restart GNOME Shell when your environment supports it. Then enable the extension:

```bash
gnome-extensions enable gitlab-monitor@fernandobouchet
```

Open the preferences:

```bash
gnome-extensions prefs gitlab-monitor@fernandobouchet
```

## Manual validation

1. Open the preferences.
2. Verify the hostname and `glab` session.
3. Select one or more projects.
4. Open the indicator menu.
5. Check the activity, merge requests, and pipeline information.
6. Use the refresh action.
7. Open an item and confirm that it leads to GitLab.
8. Disable and re-enable the extension.

To follow GNOME Shell logs:

```bash
journalctl --user --follow /usr/bin/gnome-shell
```

## Security

The extension never requests, reads, or stores the token. It executes `glab` without an intermediate shell, disables prompts, and only allows:

```text
glab version
glab auth status
glab api --method GET <allowed endpoint>
```

The allowlist includes the default branch's latest commit query through
`GET /projects/:id/repository/commits`.

It does not perform actions on merge requests, pipelines, or projects. Each item only provides a link to GitLab.

## Uninstallation

```bash
gnome-extensions uninstall gitlab-monitor@fernandobouchet
```
