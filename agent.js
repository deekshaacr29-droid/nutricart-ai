
const { chromium } = require('playwright');
const path = require('path');

// Read JSON input received from the NutriCart API.
function readInput() {
    return new Promise((resolve, reject) => {
        let input = '';

        process.stdin.setEncoding('utf8');

        process.stdin.on('data', chunk => {
            input += chunk;

            if (input.length > 100000) {
                reject(new Error('Input is too large.'));
                process.stdin.destroy();
            }
        });

        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(input));
            } catch {
                reject(new Error('Invalid JSON received from n8n.'));
            }
        });

        process.stdin.on('error', reject);
    });
}

async function main() {
    const plan = await readInput();

    const budget = Number(plan.budget);

    const people = Math.max(
        1,
        Math.floor(Number(plan.people) || 1)
    );

    const durationDays = Math.max(
        1,
        Math.floor(Number(plan.duration_days) || 7)
    );

    const allergies = Array.isArray(plan.allergies)
        ? plan.allergies.map(a => String(a).toLowerCase().trim())
        : [];

    if (!Number.isFinite(budget) || budget <= 0) {
        throw new Error('A valid positive budget is required.');
    }

    if (!Array.isArray(plan.availableProducts)) {
        throw new Error('availableProducts must be an array.');
    }

    console.log('======================================');
    console.log('NutriCart AI -', plan.test_id);
    console.log('Meal plan:', plan.meal_plan);
    console.log('People:', people);
    console.log('Duration:', durationDays, 'days');
    console.log('Budget: ₹' + budget);
    console.log('Allergies:', allergies.join(', ') || 'None declared');
    console.log('======================================');

    // Estimate quantities for the demo.
    // These estimates are not dietitian-validated recommendations.
    const scale = (people * durationDays) / 7;

    const demoQuantities = {
        RICE001: Math.round(1 * scale * 10) / 10,
        DAL001: Math.round(0.5 * scale * 10) / 10,
        OIL001: Math.round(0.2 * scale * 10) / 10,
        SUGAR001: Math.round(0.2 * scale * 10) / 10
    };

    console.log(
        `Estimated quantities for ${people} people over ${durationDays} days:`,
        demoQuantities
    );

   const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox']
});
    try {
        const page = await browser.newPage({
            viewport: null
        });

        const storePath = path.join(__dirname, 'index.html');

        await page.goto(
            'file://' + storePath.replace(/\\/g, '/'),
            { waitUntil: 'load' }
        );

        // Product IDs excluded by the upstream allergy filter.
        const excludedIds = new Set(
            (plan.excludedProducts || []).map(p => p.id)
        );

        // Products that require human review before being selected.
        const reviewIds = new Set(
            (plan.substitutionsRequiringApproval || [])
                .map(item => item.productId)
        );

        // Add only eligible products to the proposed cart.
        for (const product of plan.availableProducts) {
            if (excludedIds.has(product.id)) {
                console.log(
                    'EXCLUDED:',
                    product.name,
                    '- blocked upstream'
                );
                continue;
            }

            const card = page.locator(
                `[data-product-id="${product.id}"]`
            );

            if (await card.count() === 0) {
                console.log('MISSING PRODUCT:', product.id);
                continue;
            }

            // Defence-in-depth check against declared allergies.
            const cardText = (
                await card.innerText()
            ).toLowerCase();

            const allergenMatch = allergies.some(allergen =>
                allergen && (
                    cardText.includes(allergen) ||
                    (product.allergens || []).some(
                        item => String(item).toLowerCase().trim() === allergen
                    )
                )
            );

            if (allergenMatch) {
                console.log(
                    'EXCLUDED:',
                    product.name,
                    '- allergen match'
                );
                continue;
            }

            // Do not automatically add products requiring review.
            if (reviewIds.has(product.id)) {
                console.log(
                    'REVIEW REQUIRED:',
                    product.name,
                    '- not added automatically'
                );
                continue;
            }

            const quantity = demoQuantities[product.id];

            if (!quantity || quantity <= 0) {
                console.log(
                    'SKIPPED:',
                    product.name,
                    '- no demo quantity defined'
                );
                continue;
            }

            // Add the product to the storefront cart.
            await card.locator('button').first().click();

            const cartItem = page.locator(
                `[data-cart-product-id="${product.id}"]`
            );

            if (await cartItem.count() === 0) {
                console.log(
                    'CART ITEM NOT FOUND:',
                    product.name
                );
                continue;
            }

            const quantityInput = cartItem.locator(
                'input[type="number"]'
            );

            await quantityInput.fill(String(quantity));
            await quantityInput.dispatchEvent('change');

            console.log(
                'ADDED:',
                product.name,
                '-',
                quantity,
                product.unit
            );
        }

        // Read the displayed total from the actual storefront.
        async function getTotal() {
            const text = await page.locator('#total').innerText();

            const amount = Number(
                text.replace(/[^\d.]/g, '')
            );

            if (!Number.isFinite(amount)) {
                throw new Error('Could not read the cart total.');
            }

            return amount;
        }

        let total = await getTotal();

        console.log(
            'Initial total including delivery: ₹' + total
        );

        // Revise the cart if it exceeds the budget.
        if (total > budget) {
            console.log(
                'OVER BUDGET: Requesting cart revision.'
            );

            const reviseButton = page.getByRole('button', {
                name: /revise cart to fit budget/i
            });

            if (await reviseButton.count() === 0) {
                throw new Error(
                    'Revision button was not found.'
                );
            }

            // First use the storefront's built-in revision logic.
            await reviseButton.click();
            await page.waitForTimeout(300);

            total = await getTotal();

            // If still over budget, remove products through
            // their existing quantity controls.
            if (total > budget) {
                console.log(
                    'Storefront revision did not meet budget. ' +
                    'Trying quantity controls.'
                );

                const remainingProducts = await page
                    .locator('[data-cart-product-id]')
                    .evaluateAll(items =>
                        items.map(item => {
                            const priceMatch = item.innerText.match(
                                /₹\s*([\d.]+)\s*[×x]/
                            );

                            return {
                                id: item.dataset.cartProductId,
                                price: priceMatch
                                    ? Number(priceMatch[1])
                                    : 0
                            };
                        })
                    );

                remainingProducts.sort(
                    (a, b) => b.price - a.price
                );

                for (const product of remainingProducts) {
                    if (await getTotal() <= budget) {
                        break;
                    }

                    const item = page.locator(
                        `[data-cart-product-id="${product.id}"]`
                    );

                    if (await item.count() === 0) {
                        continue;
                    }

                    const quantityInput = item.locator(
                        'input[type="number"]'
                    );

                    if (await quantityInput.count() === 0) {
                        continue;
                    }

                    console.log(
                        'Removing from cart:',
                        product.id
                    );

                    await quantityInput.fill('0');
                    await quantityInput.dispatchEvent('change');
                    await page.waitForTimeout(100);

                    total = await getTotal();

                    console.log(
                        'Total after removal: ₹' + total
                    );
                }
            }

            total = await getTotal();

            console.log(
                'Final revised total: ₹' + total
            );
        }

        if (total <= budget) {
            console.log(
                'BUDGET CHECK PASSED: Total is within budget.'
            );
        } else {
            console.log(
                'BUDGET CHECK FAILED: Total remains over budget.'
            );
        }

        // Verify allergy exclusions in the actual cart.
        const cartProductIds = await page
            .locator('[data-cart-product-id]')
            .evaluateAll(items =>
                items.map(item => item.dataset.cartProductId)
            );

        const unsafeCartIds = cartProductIds.filter(id =>
            excludedIds.has(id)
        );

        if (unsafeCartIds.length > 0) {
            throw new Error(
                'SAFETY CHECK FAILED: Excluded products are in the cart: ' +
                unsafeCartIds.join(', ')
            );
        }

        console.log(
            'ALLERGY CHECK PASSED: No upstream-excluded product is in the cart.'
        );

        console.log(
            'Final cart product IDs:',
            cartProductIds.join(', ') || 'Empty cart'
        );

        // Human approval is required before checkout can be enabled.
        // This automation does not approve or purchase anything.
        const checkout = page.locator('#checkout');

        const checkoutDisabled = await checkout.isDisabled();

        console.log(
            'Checkout disabled pending human approval:',
            checkoutDisabled
        );

        if (!checkoutDisabled) {
            throw new Error(
                'Safety check failed: Checkout was enabled before human approval.'
            );
        }

        // Capture evidence of the final proposed cart.
        const screenshotPath = path.join(
            __dirname,
            'nutricart-n8n-test.png'
        );

        await page.screenshot({
            path: screenshotPath,
            fullPage: true
        });

        console.log(
            'Evidence saved: nutricart-n8n-test.png'
        );

        console.log(
            'Automation finished. No purchase was made.'
        );

    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(
        'NutriCart error:',
        error.message
    );

    process.exitCode = 1;
});

