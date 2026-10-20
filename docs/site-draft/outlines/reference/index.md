---
title: "Reference map"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 1
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Спроектировать точный поисковый справочник.

## План содержания

- Language: формы и встроенные функции, сигнатуры, примеры, совместимость и доступность.
- Diagnostics: стабильные коды/адреса, фактические сообщения, причина и исправление.
- JavaScript API: execution, scopes, RunContext, codecs, capabilities и analysis.
- Capability contracts: поля, значения по умолчанию и ограничения сочетаний.
- Compatibility: R7RS/SRFI coverage, заимствования и deliberate omissions.
- Packages: задача пакета, публичные imports и зависимости.

## Пример для подготовки

Шаблон записи функции: назначение; сигнатура; вход/выход; пример; ошибки; требования окружения; связанные функции. Отмечать производные данные и версию сборки.

## Источники для проверки

- [packages/arrival/docs/reference/r7rs-coverage.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/reference/r7rs-coverage.md)
- [packages/arrival/docs/reference/srfi-coverage.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/reference/srfi-coverage.md)
- [packages/arrival/docs/reference/r7rs-symbol-map.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/reference/r7rs-symbol-map.md)
