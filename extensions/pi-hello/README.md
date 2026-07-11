# @pokutuna/pi-hello

A minimal [pi](https://pi.dev) extension that adds a `/hello` command.

## Usage

```
/hello
/hello World
```

`/hello` shows a notification saying "Hello!". If you pass an argument, it greets that name instead (e.g. `/hello World` shows "Hello, World!").

## Try it locally

Build first (this package ships `dist/`, not `src/`):

```
npm run build
pi -e ./extensions/pi-hello
```

## Install

```
pi install ./extensions/pi-hello
```
