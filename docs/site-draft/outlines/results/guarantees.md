---
title: "Grounding, attestation, and guarantees"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 3
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Сформулировать точный смысл доступных проверок.

## План содержания

- Grounding: полнота прослеживаемости результата.
- Происхождение от источника не доказывает истинность.
- Attestation и её поведение при вычислении; отличие от provenance.
- Требуемая настройка наблюдения и контракты capabilities.
- Статус 0.x: известные ограничения и sandbox как текущая, а не формально доказанная граница.

## Пример для подготовки

Сравнить значение источника, вычисленное значение и литерал; отдельно ложные данные от корректно зарегистрированного источника.

## Источники для проверки

- [packages/arrival-provenance/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival-provenance/README.md)
- [packages/arrival/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival/README.md)
