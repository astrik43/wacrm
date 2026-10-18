import { describe, expect, it } from 'vitest';

import {
  contactToken,
  renderVariables,
  usesContactVariables,
} from './variables';

const contact = {
  id: 'c1',
  name: '  Dinesh  Kumar ',
  phone: '919029130001',
  email: 'd@example.com',
  company: null,
};

describe('renderVariables', () => {
  it('fills contact fields', () => {
    expect(
      renderVariables(
        '{{contact.name}}|{{contact.first_name}}|{{contact.phone}}|{{contact.email}}|{{contact.id}}',
        { contact }
      )
    ).toBe('Dinesh  Kumar|Dinesh|+919029130001|d@example.com|c1');
  });

  it('allows spaces inside the braces', () => {
    expect(renderVariables('Hi {{ contact.first_name }}', { contact })).toBe(
      'Hi Dinesh'
    );
  });

  it('uses the fallback only when the value is empty', () => {
    expect(
      renderVariables('Hi {{contact.first_name | there}}', { contact })
    ).toBe('Hi Dinesh');
    expect(
      renderVariables('Hi {{contact.first_name | there}}', {
        contact: { id: 'c2', name: '' },
      })
    ).toBe('Hi there');
    expect(renderVariables('{{contact.company|n/a}}', { contact })).toBe('n/a');
    expect(renderVariables('Hi {{contact.first_name|there}}', {})).toBe(
      'Hi there'
    );
  });

  it('treats a name that is only the phone number as no name', () => {
    for (const name of ['919731540246', '+91 97315 40246', '(973) 154-0246']) {
      expect(
        renderVariables('Hi {{contact.first_name | there}}! {{contact.name}}', {
          contact: { ...contact, name },
        })
      ).toBe('Hi there! ');
    }
    // Real names with digits still count.
    expect(
      renderVariables('Hi {{contact.first_name | there}}', {
        contact: { ...contact, name: 'Shop 24' },
      })
    ).toBe('Hi Shop');
  });

  it('keeps message.text and vars working', () => {
    expect(
      renderVariables('{{message.text}} / {{ vars.source }}', {
        messageText: 'hello',
        vars: { source: 'Ad' },
      })
    ).toBe('hello / Ad');
  });

  it('renders unknown placeholders as empty, never raw braces', () => {
    expect(renderVariables('a{{contact.nope}}b{{other}}c', { contact })).toBe(
      'abc'
    );
  });
});

describe('helpers', () => {
  it('detects contact placeholders', () => {
    expect(usesContactVariables('Hi {{ contact.name | x }}')).toBe(true);
    expect(usesContactVariables('Hi {{ vars.name }}')).toBe(false);
    expect(usesContactVariables('Hi')).toBe(false);
  });

  it('builds the inserted token', () => {
    expect(contactToken('first_name')).toBe('{{contact.first_name}}');
  });
});
