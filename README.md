# Monitor for GitLab

Read-only GNOME Shell extension for monitoring activity, merge requests, and pipelines across selected GitLab projects.

## Features

For GNOME Shell 50:

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
- [GitLab CLI (`glab`)](https://gitlab.com/gitlab-org/cli#installation).
- A `glab` session for GitLab.com or GitLab Self-Managed.

The extension does not bundle `glab`, install dependencies, or manage
credentials. Confirm that the CLI is available before installing the extension:

```bash
glab version
```

## Authentication

Authenticate from a terminal:

```bash
glab auth login --hostname gitlab.com --web
```

For GitLab Self-Managed, replace `gitlab.com` with the appropriate hostname.
GitLab CLI uses the operating system keyring by default when one is available.
Confirm the session with:

```bash
glab auth status --hostname gitlab.com
```

## Installation from a GitHub release

1. Install and authenticate `glab` as described above.
2. Open the [latest GitHub release](https://github.com/fernandobouchet/gitlab-monitor/releases/latest).
3. Under **Assets**, download
   `gitlab-monitor@fernandobouchet.shell-extension.zip`. Do not download the
   automatically generated **Source code** archives.
4. Install the downloaded ZIP (adjust the path if your browser saves downloads
   elsewhere):

```bash
gnome-extensions install --force \
  ~/Downloads/gitlab-monitor@fernandobouchet.shell-extension.zip
```

Log out and back in. Then enable the extension:

```bash
gnome-extensions enable gitlab-monitor@fernandobouchet
```

Open its preferences and select the projects to monitor:

```bash
gnome-extensions prefs gitlab-monitor@fernandobouchet
```

## Building and installing from source

The packaging command requires GNOME Shell extension tools and `gettext`
(`msgfmt`). On Debian or Ubuntu, install them with:

```bash
sudo apt install gettext gnome-shell
```

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

Log out and back in, or restart GNOME Shell when your environment supports it.
Then enable the extension:

```bash
gnome-extensions enable gitlab-monitor@fernandobouchet
```

Open the preferences:

```bash
gnome-extensions prefs gitlab-monitor@fernandobouchet
```

## Updating

Download the ZIP from the newest GitHub release and repeat the installation
command with `--force`. Log out and back in before using the updated extension.

## Releases

GitHub Actions packages the extension and attaches the ZIP to a release when a
tag beginning with `v` is pushed:

```bash
git tag v1.0.5
git push origin v1.0.5
```

The release artifact is the `.shell-extension.zip` file created by the workflow,
not either of GitHub's automatically generated source archives.

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

### Why GitLab CLI is required

The extension delegates authentication and GitLab API access to the official
GitLab CLI. This avoids implementing credential management or requesting and
storing access tokens inside the extension.

`glab` is not bundled with the extension. Every process is started directly,
without an intermediate shell, uses a timeout, can be cancelled when the
extension is disabled, and is restricted to the read-only commands listed
below.

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
