# rb-notes-api

A notes API in Ruby with Sinatra.

## Features

- List notes: `GET /notes`
- Create notes: `POST /notes`
- Search notes: `GET /notes/search`
- Export a note as Markdown: `GET /notes/:id/export.md`

## Roadmap

- Share notes via link

## Setup

```sh
bundle install
bundle exec rackup
```
