---
title: "Connecting an existing tool runtime"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 2
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Подключить имеющиеся инструменты и правила хоста к Arrival.

## План содержания

- От каталога инструментов к именам и контрактам Scheme.
- Живое описание среды для модели.
- Переход из capability в обычный dispatch инструмента.
- Разрешения, ожидание, отмена и ошибки внутренних вызовов.
- Возврат значений в программу и результатов в transcript.

## Пример для подготовки

Разобрать путь harness: scheme_repl → EnvCapability → ToolCallJob → результат; рядом дать минимальный адаптер без зависимостей harness.

## Источники для проверки

- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
