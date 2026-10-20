---
title: "Contributor reading paths"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 1
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Сохранить техническую глубину для разработчиков интерпретатора.

## План содержания

- Architecture и карта подсистем.
- Values, provenance, membrane и execution.
- Static analysis: validator, type lens, oracle; staged-возможности отмечать отдельно.
- Principles, rulings, glossary и dependency strata.
- Тестовые законы и contribution workflow.
- Существующие источники сохраняют свои устойчивые идентификаторы; устранять противоречия с реализацией перед публикацией.

## Пример для подготовки

Маршруты: новый builtin; новая capability; изменение reader; исправление provenance. Для каждого — необходимые документы и проверки.

## Источники для проверки

- [packages/arrival/docs/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/README.md)
- [packages/arrival/docs/PRINCIPLES.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/PRINCIPLES.md)
- [packages/arrival/docs/RULINGS.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/RULINGS.md)
- [packages/arrival/docs/GLOSSARY.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/GLOSSARY.md)
- [CONTRIBUTING.md](https://github.com/here-build/arrival/blob/main/CONTRIBUTING.md)
