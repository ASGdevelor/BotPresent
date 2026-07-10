import { Keyboard } from "grammy";
import { BUTTONS } from "./constants";

export function createMainKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.presentation)
    .row()
    .text(BUTTONS.research)
    .resized()
    .persistent();
}

