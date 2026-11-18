# re-agents library

The list of well-known Agent Skills that re-agents, a desktop app for managing the skills AI
agents load, shows in its Library: skills for Claude Code, Codex, Cursor and other agents, each in a folder
with a `SKILL.md`.

- **`repos.txt`** is the reviewed list of GitHub repositories, one per line, with a note on why
  each is in it. Every entry contains real `SKILL.md` skills, is maintained and isn't archived.
  Bulk collections of copied skills, archived repositories and look-alikes of official ones are
  left out.
- **`catalog.json`** is built from that list: each repository's description, stars, last
  activity and licence, and each skill's name, description and version, read from its front
  matter.
- **`build.mjs`** builds it (`node build.mjs`; needs `git` and `gh`). A GitHub Action runs it
  every day and whenever the list changes, so the app always gets current numbers.

re-agents downloads `catalog.json` at most twice a day, from
`https://raw.githubusercontent.com/kenjiro-work/re-agents-library/main/catalog.json`, and falls
back to the copy it ships with. The request carries nothing about you or your skills.

To suggest a repository, open an issue or a pull request that adds one line to `repos.txt`.
