---
title: "Modules and Sugarcoat"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 5
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Показать сохранение, повторное использование и человеческое представление программ.

## План содержания

- Модули: подключение loader-capability, require, относительные пути и ответственность resolver.
- Форматы данных подключаются отдельными capabilities.
- Sugarcoat как редактируемое представление канонических s-expressions.
- Семантическое сохранение и сохранение исходных байтов — разные обещания.
- При расширении раздела разделить Modules и Sugarcoat на две страницы.

## Пример для подготовки

Один модуль с функцией, использующий его скрипт и два представления скрипта.

## Источники для проверки

- [packages/arrival-modules/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival-modules/README.md)
- [packages/arrival-sugarcoat/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival-sugarcoat/README.md)
