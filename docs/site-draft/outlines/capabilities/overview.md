---
title: "Your first capability"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 1
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Представить EnvCapability как единицу расширения среды.

## План содержания

- Пять частей: configuration, resources, symbols, prelude, deps.
- Модульная декларация EnvCapability.define; состояние конкретного запуска передаётся отдельно.
- Встроенная библиотека и прикладные расширения используют одну модель.
- symbol.rosetta, кодеки и минимальный типизированный контракт.
- Маршрут: конфигурация → ресурсы → зависимости → контракты.

## Пример для подготовки

Начать с небольшой capability обработки записей и постепенно добавить внешний клиент; без реальной сети в tutorial.

## Источники для проверки

- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
- [packages/arrival/src/common/capability.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/capability.ts)
