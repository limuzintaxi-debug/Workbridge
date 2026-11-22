/**
 * WORKBRIDGE MALL — vehicle buy & sell and electronic discount shops.
 *
 * Both categories use one photo plus one text box, exactly as requested: no
 * separate model/year/licence fields, no cart, no payment gateway. Photos are
 * resized in the browser before upload so mobile data stays light.
 */
import { api } from '../api.js';
import { esc, toast, busy, readImageFile } from '../ui.js';

/** Downscale and re-encode a photo so listings stay lightweight. */
function compress(file, maxSide = 1100, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.onerror = () => reject(new Error('Could not read that photo.'));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.readAsDataURL(file);
  });
}

async function photoFrom(input) {
  const file = input && input.files && input.files[0];
  if (!file) return null;
  try {
    return await compress(file);
  } catch {
    return readImageFile(file);
  }
}

function priceLine(product) {
  const currency = product.currency || '';
  if (product.discount) {
    return `<span style="text-decoration:line-through" class="muted">${esc(
      String(product.original_price)
    )} ${esc(currency)}</span> <strong>${esc(String(product.discounted_price))} ${esc(
      currency
    )}</strong>`;
  }
  if (product.discounted_price > 0) {
    return `<strong>${esc(String(product.discounted_price))} ${esc(currency)}</strong>`;
  }
  return product.original_price > 0
    ? `<strong>${esc(String(product.original_price))} ${esc(currency)}</strong>`
    : '<span class="muted">Price on request</span>';
}

export async function mallView(ctx) {
  const shopId = ctx.query ? ctx.query.get('shop') : null;
  const [{ vehicles }, { shops }] = await Promise.all([
    api.get('/mall/vehicles'),
    api.get('/mall/shops')
  ]);
  const products = shopId ? (await api.get(`/mall/products?shop_id=${encodeURIComponent(shopId)}`)).products : [];
  const shop = shopId ? shops.find((s) => s.id === shopId) : null;
  const me = ctx.user;
  const isAdmin = me && me.role === 'admin';

  const vehicleCards = vehicles.length
    ? vehicles
        .map(
          (vehicle) => `<article class="card">
            ${vehicle.image ? `<img src="${esc(vehicle.image)}" alt="Vehicle photo" style="width:100%;border-radius:10px;margin-bottom:10px" />` : ''}
            <p style="margin:0 0 8px;white-space:pre-wrap">${esc(vehicle.description)}</p>
            ${
              vehicle.price > 0
                ? `<p style="margin:0 0 6px"><strong>${esc(String(vehicle.price))} ${esc(vehicle.currency)}</strong></p>`
                : ''
            }
            ${vehicle.location ? `<p class="muted" style="margin:0 0 6px">${esc(vehicle.location)}</p>` : ''}
            <div class="btn-row">
              ${
                vehicle.contact_phone
                  ? `<a class="btn btn-navy btn-sm" href="tel:${esc(vehicle.contact_phone)}">Call ${esc(vehicle.contact_phone)}</a>`
                  : ''
              }
              ${
                me && (me.id === vehicle.seller_id || isAdmin)
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-vehicle="${esc(vehicle.id)}">Remove</button>`
                  : ''
              }
            </div>
          </article>`
        )
        .join('')
    : `<div class="empty">No vehicles listed yet.</div>`;

  const shopCards = shops.length
    ? shops
        .map(
          (item) => `<article class="card" style="margin-bottom:10px">
            <h3 style="margin:0"><a href="#/mall?shop=${esc(item.id)}">${esc(item.name)}</a></h3>
            <p class="muted" style="margin:6px 0 0">${esc(item.name)} • ${esc(item.phone || 'No phone')} • ${esc(
              item.address || 'Address not given'
            )}</p>
            <p class="muted" style="margin:6px 0 0">${item.product_count} product(s)</p>
            <div class="btn-row">
              <a class="btn btn-ghost btn-sm" href="#/mall?shop=${esc(item.id)}">Open shop</a>
              ${
                me && (me.id === item.owner_id || isAdmin)
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-shop="${esc(item.id)}">Remove shop</button>`
                  : ''
              }
            </div>
          </article>`
        )
        .join('')
    : `<div class="empty">No shops yet. Create the first electronic shop.</div>`;

  const productCards = products.length
    ? products
        .map(
          (product) => `<article class="card" style="margin-bottom:10px">
            ${product.image ? `<img src="${esc(product.image)}" alt="Product photo" style="width:100%;border-radius:10px;margin-bottom:10px" />` : ''}
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
              <h3 style="margin:0">${esc(product.title || 'Product')}</h3>
              ${product.discount ? '<span class="pill ok">DISCOUNT</span>' : ''}
            </div>
            <p style="margin:8px 0;white-space:pre-wrap">${esc(product.details)}</p>
            <p style="margin:0 0 8px">${priceLine(product)}</p>
            <div class="btn-row">
              ${
                shop && shop.phone
                  ? `<a class="btn btn-navy btn-sm" href="tel:${esc(shop.phone)}">Call shop</a>`
                  : ''
              }
              ${
                me && (me.id === product.owner_id || isAdmin)
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-product="${esc(product.id)}">Remove</button>`
                  : ''
              }
            </div>
          </article>`
        )
        .join('')
    : `<div class="empty">No products in this shop yet.</div>`;

  const canSell = Boolean(me);
  const myShop = shop && me && shop.owner_id === me.id;

  const html = `<div class="container">
    <div class="section-head">
      <div>
        <h1>WORKBRIDGE MALL</h1>
        <p class="muted" style="margin:0">Vehicles to buy &amp; sell, and electronic shops with discount products.</p>
      </div>
      <div class="btn-row">
        <a class="btn ${shopId ? 'btn-ghost' : 'btn-navy'} btn-sm" href="#/mall">Vehicles</a>
        <a class="btn ${shopId ? 'btn-navy' : 'btn-ghost'} btn-sm" href="#/mall?tab=shops">Electronic Discount Shop</a>
      </div>
    </div>

    ${
      shopId
        ? `<div class="card">
            <div class="section-head"><div>
              <h2 style="margin:0;font-size:1.15rem">${esc(shop ? shop.name : 'Shop')}</h2>
              <p class="muted" style="margin:4px 0 0">${shop ? `${esc(shop.name)} • ${esc(shop.phone || 'No phone')} • ${esc(shop.address || 'Address not given')}` : ''}</p>
            </div></div>
            ${productCards}
          </div>
          ${
            myShop
              ? `<form id="product-form" class="card" style="margin-top:14px">
                  <h3 style="margin-top:0">Add a product</h3>
                  <div class="field"><label for="product-title">Product name</label><input id="product-title" name="title" /></div>
                  <div class="field"><label for="product-photo">Product photo</label><input id="product-photo" name="image" type="file" accept="image/*" capture="environment" /></div>
                  <div class="field">
                    <label for="product-details">Product details, original price and discounted price</label>
                    <textarea id="product-details" name="details" rows="4" required placeholder="Write everything in this one box: model, description, original price, discounted price."></textarea>
                  </div>
                  <div class="split">
                    <div class="field"><label for="product-original">Original price</label><input id="product-original" name="original_price" type="number" min="0" step="0.01" /></div>
                    <div class="field"><label for="product-discounted">Discounted price</label><input id="product-discounted" name="discounted_price" type="number" min="0" step="0.01" /></div>
                  </div>
                  <button type="submit" class="btn btn-navy">Publish product</button>
                </form>`
              : ''
          }`
        : `<div class="split">
            <div>
              <h2 style="font-size:1.15rem">Vehicles — Buy &amp; Sell</h2>
              <div class="grid">${vehicleCards}</div>
              ${
                canSell
                  ? `<form id="vehicle-form" class="card" style="margin-top:14px">
                      <h3 style="margin-top:0">Sell your vehicle</h3>
                      <div class="field"><label for="vehicle-photo">Vehicle photograph</label><input id="vehicle-photo" name="image" type="file" accept="image/*" capture="environment" /></div>
                      <div class="field">
                        <label for="vehicle-description">Vehicle details</label>
                        <textarea id="vehicle-description" name="description" rows="4" required placeholder="Write model, year, price, location and all other details in this box."></textarea>
                      </div>
                      <div class="split">
                        <div class="field"><label for="vehicle-price">Price</label><input id="vehicle-price" name="price" type="number" min="0" step="0.01" /></div>
                        <div class="field"><label for="vehicle-location">Location</label><input id="vehicle-location" name="location" /></div>
                      </div>
                      <div class="field"><label for="vehicle-phone">Contact phone</label><input id="vehicle-phone" name="contact_phone" inputmode="tel" value="${esc(me.phone || '')}" /></div>
                      <button type="submit" class="btn btn-navy">Publish vehicle</button>
                    </form>`
                  : `<div class="card" style="margin-top:14px"><p class="muted" style="margin:0">Sign in as a worker or business to publish a vehicle or open a shop.</p><div class="btn-row"><a class="btn btn-navy btn-sm" href="#/worker/signin">Worker sign in</a><a class="btn btn-ghost btn-sm" href="#/business/signin">Business sign in</a></div></div>`
              }
            </div>
            <div>
              <h2 style="font-size:1.15rem">Electronic Discount Shop</h2>
              ${shopCards}
              ${
                canSell
                  ? `<form id="shop-form" class="card" style="margin-top:14px">
                      <h3 style="margin-top:0">Create your shop</h3>
                      <div class="field"><label for="shop-name">Shop name</label><input id="shop-name" name="name" required /></div>
                      <div class="field"><label for="shop-phone">Phone number</label><input id="shop-phone" name="phone" inputmode="tel" value="${esc(me.phone || '')}" /></div>
                      <div class="field"><label for="shop-address">Short address</label><input id="shop-address" name="address" /></div>
                      <div class="field"><label for="shop-description">Short description (optional)</label><input id="shop-description" name="description" /></div>
                      <button type="submit" class="btn btn-navy">Create shop</button>
                    </form>`
                  : ''
              }
            </div>
          </div>`
    }
  </div>`;

  return {
    title: 'WORKBRIDGE MALL',
    html,
    mount() {
      const vehicleForm = document.getElementById('vehicle-form');
      if (vehicleForm) {
        vehicleForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const submit = vehicleForm.querySelector('button[type="submit"]');
          busy(submit, true, 'Publishing…');
          try {
            const image = await photoFrom(vehicleForm.image);
            await api.post('/mall/vehicles', {
              image,
              description: vehicleForm.description.value.trim(),
              price: Number(vehicleForm.price.value || 0),
              location: vehicleForm.location.value.trim(),
              contact_phone: vehicleForm.contact_phone.value.trim()
            });
            toast('Vehicle published.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(submit, false);
          }
        });
      }

      const shopForm = document.getElementById('shop-form');
      if (shopForm) {
        shopForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const submit = shopForm.querySelector('button[type="submit"]');
          busy(submit, true, 'Creating…');
          try {
            const result = await api.post('/mall/shops', {
              name: shopForm.name.value.trim(),
              phone: shopForm.phone.value.trim(),
              address: shopForm.address.value.trim(),
              description: shopForm.description.value.trim()
            });
            toast('Shop created.', 'ok');
            location.hash = `#/mall?shop=${result.shop.id}`;
          } catch (error) {
            toast(error.message, 'error');
            busy(submit, false);
          }
        });
      }

      const productForm = document.getElementById('product-form');
      if (productForm) {
        productForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const submit = productForm.querySelector('button[type="submit"]');
          busy(submit, true, 'Publishing…');
          try {
            const image = await photoFrom(productForm.image);
            await api.post('/mall/products', {
              shop_id: shopId,
              title: productForm.title.value.trim(),
              details: productForm.details.value.trim(),
              original_price: Number(productForm.original_price.value || 0),
              discounted_price: Number(productForm.discounted_price.value || 0),
              image
            });
            toast('Product published.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(submit, false);
          }
        });
      }

      for (const button of document.querySelectorAll('[data-remove-vehicle]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Removing…');
          try {
            await api.del(`/mall/vehicles/${button.dataset.removeVehicle}`);
            toast('Vehicle listing removed.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-remove-product]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Removing…');
          try {
            await api.del(`/mall/products/${button.dataset.removeProduct}`);
            toast('Product removed.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-remove-shop]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Removing…');
          try {
            await api.del(`/mall/shops/${button.dataset.removeShop}`);
            toast('Shop removed.', 'ok');
            location.hash = '#/mall?tab=shops';
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
    }
  };
}
