# Monitor for GitLab

Read-only GNOME Shell extension for monitoring activity, merge requests, and pipelines across selected GitLab projects.

## Status

Initial MVP implemented for GNOME Shell 50:

- Authentication reused from GitLab CLI (`glab`).
- Selection of up to ten projects.
- Selected projects, their default branches, latest commits, pipelines, and open merge requests.
- Optional display of the latest commit, pipeline, and open merge requests.
- Manual refresh and configurable polling.
- Optional notifications for pipelines, new merge requests, and pushes to the default branch.
- Links to open projects and latest commits in GitLab.
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
  --extra-source=branch-symbolic.svg \
  --extra-source=git-symbolic.svg \
  --extra-source=external-link-symbolic.svg \
  --extra-source=LICENSE \
  --schema=schemas/org.gnome.shell.extensions.gitlab-monitor.gschema.xml \
  --podir=po \
  --gettext-domain=gitlab-monitor \
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

## Releases

GitHub Actions packages the extension and attaches the ZIP to a release when a
tag beginning with `v` is pushed:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Manual validation

1. Open the preferences.
2. Verify the hostname and `glab` session.
3. Select one or more projects.
4. Open the indicator menu.
5. Check each project's branch, latest commit, pipeline, and merge requests.
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

It does not perform actions on merge requests, pipelines, or projects. Project,
commit, pipeline, and merge request items only provide links to GitLab.

The preferences can copy the `glab` login command to the clipboard, but only
after the user activates the copy button.

## Trademark notice

This extension is not affiliated, endorsed, sponsored, or approved with or by
GitLab Inc.

GITLAB is a trademark of GitLab Inc. in the United States and other countries
and regions.

## License

This project is licensed under GPL-2.0-or-later. See [LICENSE](LICENSE).

The Git logomark is by Jason Long, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), and adapted for
symbolic rendering.

## Uninstallation

```bash
gnome-extensions uninstall gitlab-monitor@fernandobouchet
```
