---
title: "JavaScript interop"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 3
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Объяснить контракт границы Scheme ↔ JavaScript.

## План содержания

- Кодеки входа и выхода; this.configuration и this.resources.
- Контейнеры, функции и идентичность на границе.
- Асинхронная реализация host-функции и bare Promise как значение — разные случаи.
- Ограничения callback lifetime.
- Где остаётся provenance после toJS.

## Пример для подготовки

Типизированная функция с коллекцией на входе; корректный и некорректный возврат.

## Источники для проверки

- [packages/arrival/docs/membrane.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/membrane.md)
- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
