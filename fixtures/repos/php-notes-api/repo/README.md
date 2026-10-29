# php-notes-api

A notes API in PHP with Slim.

## Features

- List notes: `GET /notes`
- Create notes: `POST /notes`
- Search notes: `GET /notes/search`
- Export a note as Markdown: `GET /notes/{id}/export.md`

## Roadmap

- Share notes via link

## Setup

```sh
composer install
php -S localhost:8080 -t public
```
