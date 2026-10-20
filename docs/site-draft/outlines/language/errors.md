---
title: "Understanding errors"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 4
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Помочь агенту и человеку исправить программу по диагностике.

## План содержания

- Неизвестное имя, неверный аргумент, намеренно отсутствующая операция.
- Отсутствующая конфигурация: кто владеет функцией и что нужно предоставить.
- Статическая проверка и ошибки во время исполнения.
- Что диагностика гарантирует и чего не может установить заранее.
- Как хост сохраняет причину и управляет повторными попытками.

## Пример для подготовки

Три реальных сообщения с минимальным исправлением; отдельный пример ошибки, которую должен исправить хост, а не модель.

## Источники для проверки

- [packages/arrival/src/common/degradation.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/degradation.ts)
- [packages/arrival/src/static-validation/validate-program.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/static-validation/validate-program.ts)
