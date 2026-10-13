import { describe, expect, it } from 'vitest';

import { deriveFulfillmentEvents, type FulfillmentState } from './events';

const none: FulfillmentState = {
  trackingNumber: null,
  trackingUrl: null,
  shipmentStatus: null,
};

describe('deriveFulfillmentEvents', () => {
  it('announces tracking on a new shipment that has a number', () => {
    expect(
      deriveFulfillmentEvents(null, { ...none, trackingNumber: 'EX1' })
    ).toEqual(['tracking_added']);
  });

  it('says nothing for a new shipment without tracking', () => {
    expect(deriveFulfillmentEvents(null, none)).toEqual([]);
  });

  it('announces tracking when a number first appears on an update', () => {
    expect(
      deriveFulfillmentEvents(none, { ...none, trackingNumber: 'EX1' })
    ).toEqual(['tracking_added']);
  });

  it('announces a changed tracking number', () => {
    expect(
      deriveFulfillmentEvents(
        { ...none, trackingNumber: 'EX1' },
        { ...none, trackingNumber: 'EX2' }
      )
    ).toEqual(['tracking_updated']);
  });

  it('ignores a link that appears or changes while the number is the same', () => {
    const prev = { ...none, trackingNumber: 'EX1' };
    expect(
      deriveFulfillmentEvents(prev, {
        ...prev,
        trackingUrl: 'https://t.example/EX1',
      })
    ).toEqual([]);
    expect(
      deriveFulfillmentEvents(
        { ...prev, trackingUrl: 'https://t.example/a' },
        { ...prev, trackingUrl: 'https://t.example/b' }
      )
    ).toEqual([]);
  });

  it('treats a link as the tracking when there is no number', () => {
    expect(
      deriveFulfillmentEvents(null, { ...none, trackingUrl: 'https://t/a' })
    ).toEqual(['tracking_added']);
    expect(
      deriveFulfillmentEvents(
        { ...none, trackingUrl: 'https://t/a' },
        { ...none, trackingUrl: 'https://t/b' }
      )
    ).toEqual(['tracking_updated']);
  });

  it('does not re-announce when a number arrives after a link', () => {
    expect(
      deriveFulfillmentEvents(
        { ...none, trackingUrl: 'https://t/a' },
        { ...none, trackingUrl: 'https://t/a', trackingNumber: 'EX1' }
      )
    ).toEqual([]);
  });

  it('fires out for delivery and delivered once each', () => {
    const shipped = { ...none, trackingNumber: 'EX1' };
    const out = { ...shipped, shipmentStatus: 'out_for_delivery' };
    const done = { ...shipped, shipmentStatus: 'delivered' };

    expect(deriveFulfillmentEvents(shipped, out)).toEqual(['out_for_delivery']);
    expect(deriveFulfillmentEvents(out, out)).toEqual([]);
    expect(deriveFulfillmentEvents(out, done)).toEqual(['delivered']);
    expect(deriveFulfillmentEvents(done, done)).toEqual([]);
  });

  it('ignores out for delivery arriving after delivered', () => {
    expect(
      deriveFulfillmentEvents(
        { ...none, trackingNumber: 'EX1', shipmentStatus: 'delivered' },
        { ...none, trackingNumber: 'EX1', shipmentStatus: 'out_for_delivery' }
      )
    ).toEqual([]);
  });

  it('sends only delivered for a parcel first seen already delivered', () => {
    expect(
      deriveFulfillmentEvents(null, {
        ...none,
        trackingNumber: 'EX1',
        shipmentStatus: 'delivered',
      })
    ).toEqual(['delivered']);
  });

  it('ignores other shipment statuses', () => {
    expect(
      deriveFulfillmentEvents(
        { ...none, trackingNumber: 'EX1' },
        { ...none, trackingNumber: 'EX1', shipmentStatus: 'in_transit' }
      )
    ).toEqual([]);
  });

  it('sends nothing for a cancelled or failed fulfillment', () => {
    for (const status of ['cancelled', 'failure']) {
      expect(
        deriveFulfillmentEvents(null, {
          ...none,
          trackingNumber: 'EX1',
          shipmentStatus: 'delivered',
          status,
        })
      ).toEqual([]);
    }
  });
});
