import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatWhatsAppText, stripWhatsAppFormatting } from './whatsapp-format';

const html = (text: string) => renderToStaticMarkup(<>{formatWhatsAppText(text)}</>);

describe('formatWhatsAppText', () => {
  it('renders bold, italic, strikethrough and monospace like WhatsApp', () => {
    expect(html('*Estelle Luxe | Order Verification*')).toBe(
      '<strong>Estelle Luxe | Order Verification</strong>'
    );
    expect(html('order *#EL1700* worth *₹2293.30*')).toBe(
      'order <strong>#EL1700</strong> worth <strong>₹2293.30</strong>'
    );
    expect(html('_Estelle Luxe Team_ 🙂')).toBe('<em>Estelle Luxe Team</em> 🙂');
    expect(html('~was ₹999~ now ₹799')).toBe('<del>was ₹999</del> now ₹799');
    expect(html('code: ```ABC123```')).toContain('<code');
    expect(html('*_both_*')).toBe('<strong><em>both</em></strong>');
  });

  it('leaves marks that are not formatting as typed', () => {
    for (const text of [
      '2*3*4',
      'snake_case_name',
      'a * b * c',
      '*not closed',
      '* spaced *',
      'line one *\nline two*',
    ]) {
      expect(html(text)).toBe(
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      );
    }
  });

  it('never turns customer text into HTML', () => {
    expect(html('*<img src=x onerror=alert(1)>*')).toBe(
      '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>'
    );
  });
});

describe('stripWhatsAppFormatting', () => {
  it('drops the marks for one-line previews', () => {
    expect(stripWhatsAppFormatting('*Estelle Luxe | Order Verification*')).toBe(
      'Estelle Luxe | Order Verification'
    );
    expect(stripWhatsAppFormatting('*_both_* and 2*3*4')).toBe('both and 2*3*4');
    expect(stripWhatsAppFormatting(null)).toBe('');
  });
});
