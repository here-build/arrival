---
title: "Provenance and cache contracts"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 5
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Правильно объявлять поведение внешних функций.

## План содержания

- Входные и выходные кодеки — исполняемый контракт.
- source, pipe и sink; остальные роли вынести в reference.
- Независимость provenance role и cacheClass.
- queries/effects и требования к сериализуемости.
- Возвращающий значение эффект не объявлять void sink.
- Типы и метаданные для tooling выводятся из деклараций там, где поддержаны.

## Пример для подготовки

Источник записей, чистое преобразование и запись без результата; отдельная таблица record/replay для выбранных контрактов.

## Источники для проверки

- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
- [packages/arrival/docs/environments.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/environments.md)
